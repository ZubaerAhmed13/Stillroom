import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { atomic, listCollections, openCatalog } from './catalog.mjs';
import { backupCollectionName, exportHostedBackup, validBackupDescription } from './hosted-backup.mjs';
import { formats, hasMediaSignature } from './local-media.mjs';
import { MAX_FILE, MEDIA_ID } from './media.mjs';
import { requireStorageCapacity } from './storage-budget.mjs';

const dataPath = directory => resolve(directory);
function separate(dataDir, destination) {
  if (destination === dataDir || destination.startsWith(dataDir + sep) || dataDir.startsWith(destination + sep)) {
    throw new Error('Use a backup directory outside the application data directory.');
  }
}
async function exists(path) {
  try { return await stat(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function exportBackup(directory, target) {
  const source = dataPath(directory);
  const destination = resolve(target);
  separate(source, destination);
  if (await exists(destination)) throw new Error('The backup directory already exists.');
  if (!await exists(join(source, 'catalog.sqlite'))) throw new Error('The local media catalog does not exist.');
  const staging = join(dirname(destination), '.stillroom-backup-' + randomUUID());
  const db = openCatalog(source);
  try {
    const items = db.prepare(`SELECT id, title, name, mime, size, fingerprint, created, description, favourite,
      collection_id AS collectionId FROM media WHERE status = 'ready' ORDER BY created`).all();
    const collections = listCollections(db);
    await mkdir(join(staging, 'media'), { recursive: true, mode: 0o700 });
    for (const item of items) {
      const file = join(source, 'media', item.id);
      if ((await stat(file)).size !== item.size) throw new Error('Original is incomplete for ' + item.name + '.');
      await copyFile(file, join(staging, 'media', item.id), constants.COPYFILE_EXCL);
    }
    await writeFile(join(staging, 'catalog.json'), JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), collections, items }, null, 2) + '\n', { mode: 0o600 });
    await rename(staging, destination);
    return items.length;
  } finally {
    db.close();
    await rm(staging, { recursive: true, force: true });
  }
}

export async function restoreBackup(directory, source) {
  const destination = dataPath(directory);
  const backup = resolve(source);
  separate(destination, backup);
  const manifest = join(backup, 'catalog.json');
  if (!(await lstat(manifest)).isFile()) throw new Error('Invalid backup catalog file.');
  const catalog = JSON.parse(await readFile(manifest, 'utf8'));
  if (!catalog || ![1, 2, 3].includes(catalog.version) || !Array.isArray(catalog.items) ||
      (catalog.version >= 2 && !Array.isArray(catalog.collections))) throw new Error('Unsupported backup catalog.');
  if (catalog.version < 3) return restoreCatalog(destination, backup, catalog);
  if (!(await lstat(join(backup, 'media'))).isDirectory()) throw new Error('Invalid backup media directory.');
  try {
    await lstat(destination);
    throw new Error('A hosted backup requires a new restore directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = join(dirname(destination), '.stillroom-restore-' + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  try {
    const count = await restoreCatalog(staging, backup, catalog);
    await rename(staging, destination);
    return count;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function restoreCatalog(destination, backup, catalog) {
  const hosted = catalog.version === 3;
  const collections = new Map();
  if (catalog.version >= 2) {
    for (const collection of catalog.collections) {
      if (!collection || !MEDIA_ID.test(collection.id) || collections.has(collection.id)) throw new Error('Invalid backup collection.');
      collections.set(collection.id, backupCollectionName(collection.name));
    }
  }
  await mkdir(join(destination, 'media'), { recursive: true, mode: 0o700 });
  const db = openCatalog(destination);
  let count = 0;
  try {
    const insertCollection = db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)');
    const collectionById = db.prepare('SELECT id FROM collections WHERE id = ?');
    const collectionByName = db.prepare('SELECT id FROM collections WHERE name = ?');
    function restoreCollection(id, name) {
      if (collectionById.get(id)) return;
      let candidate = name;
      for (let index = 1; collectionByName.get(candidate); index++) {
        const suffix = index === 1 ? ' (restored)' : ` (restored ${index})`;
        candidate = name.slice(0, 80 - suffix.length).trimEnd() + suffix;
      }
      insertCollection.run(id, candidate);
    }
    const restoreDetails = catalog.version >= 2 ? `,
      collection_id = excluded.collection_id, description = excluded.description, favourite = excluded.favourite` : '';
    const upsertMedia = db.prepare(`INSERT INTO media (id, title, name, mime, size, fingerprint, status, created, collection_id, description, favourite)
      VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, name = excluded.name, mime = excluded.mime, size = excluded.size,
      fingerprint = excluded.fingerprint, status = 'ready', created = excluded.created, version = media.version + 1${restoreDetails}`);
    const ids = new Set();
    for (const item of catalog.items) {
      if (!item || !MEDIA_ID.test(item.id) || !Object.hasOwn(formats, item.mime) ||
          !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_FILE ||
          !Number.isSafeInteger(item.created) || !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
          typeof item.title !== 'string' || typeof item.name !== 'string') throw new Error('Invalid backup media record.');
      if (hosted && (typeof item.id !== 'string' || ids.has(item.id) ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) {
        throw new Error('Invalid hosted backup checksum or duplicate media ID.');
      }
      ids.add(item.id);
      const { collectionId, description, favourite } = catalog.version >= 2 ? item : { collectionId: null, description: '', favourite: 0 };
      if ((collectionId !== null && !collections.has(collectionId)) || !validBackupDescription(description) ||
          ![0, 1].includes(favourite)) throw new Error('Invalid backup media details.');
      const original = join(backup, 'media', item.id);
      const fileInfo = await (hosted ? lstat(original) : stat(original));
      if (!fileInfo.isFile() || fileInfo.size !== item.size) throw new Error('Invalid backup original or file size.');
      const file = await open(original, 'r');
      try {
        const signature = Buffer.alloc(128);
        const { bytesRead } = await file.read(signature);
        if (!hasMediaSignature(signature.subarray(0, bytesRead), item.mime)) throw new Error('Invalid backup file format.');
      } finally {
        await file.close();
      }
      const current = db.prepare('SELECT status, size FROM media WHERE id = ?').get(item.id);
      const restored = join(destination, 'media', item.id);
      if (current?.status === 'uploading') throw new Error('Cancel the conflicting pending upload first.');
      const local = await exists(restored);
      if (current?.status === 'ready' && local?.size === current.size) continue;
      if (!local || local.size !== item.size || item.size > (current?.size ?? 0)) {
        requireStorageCapacity(db, Math.max(0, item.size - (current?.size ?? 0)));
      }
      if (!local || local.size !== item.size) {
        const staging = restored + '.' + randomUUID();
        try {
          await copyFile(original, staging, constants.COPYFILE_EXCL);
          if (hosted) {
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(staging)) hash.update(chunk);
            if (hash.digest('hex') !== item.sha256) throw new Error('The backup checksum does not match the original.');
          }
          await rename(staging, restored);
        } finally {
          await rm(staging, { force: true });
        }
      }
      atomic(db, () => {
        if (collectionId !== null) restoreCollection(collectionId, collections.get(collectionId));
        upsertMedia.run(item.id, item.title, item.name, item.mime, item.size, item.fingerprint, item.created, collectionId, description, favourite);
      });
      count++;
    }
    atomic(db, () => {
      for (const [id, name] of collections) restoreCollection(id, name);
    });
    return count;
  } finally {
    db.close();
  }
}

async function promptOwner() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run the hosted export in an interactive terminal.');
  const output = new Writable({ write(chunk, encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const lines = rl[Symbol.asyncIterator]();
  try {
    process.stdout.write('Stillroom owner email (hidden): ');
    const email = (await lines.next()).value;
    if (!email?.trim()) throw new Error('Enter your Stillroom owner email.');
    process.stdout.write('\nStillroom owner password (hidden): ');
    const password = (await lines.next()).value;
    if (!password) throw new Error('Enter your Stillroom owner password.');
    return { email: email.trim(), password };
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  const [command, directory] = process.argv.slice(2);
  const dataDir = process.env.STILLROOM_DATA_DIR || join(dirname(filename), '.data');
  try {
    if (!directory || !['export', 'export-hosted', 'restore'].includes(command)) {
      throw new Error('Usage: npm run backup -- export|export-hosted|restore /path/to/backup');
    }
    const count = command === 'export-hosted'
      ? await exportHostedBackup(directory, await promptOwner())
      : await (command === 'export' ? exportBackup : restoreBackup)(dataDir, directory);
    console.log((command === 'restore' ? 'Restored ' : 'Backed up ') + count + ' media item(s).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
