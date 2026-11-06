import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCatalog } from './catalog.mjs';
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
    const items = db.prepare("SELECT id, title, name, mime, size, fingerprint, created FROM media WHERE status = 'ready' ORDER BY created").all();
    await mkdir(join(staging, 'media'), { recursive: true, mode: 0o700 });
    for (const item of items) {
      const file = join(source, 'media', item.id);
      if ((await stat(file)).size !== item.size) throw new Error('Original is incomplete for ' + item.name + '.');
      await copyFile(file, join(staging, 'media', item.id), constants.COPYFILE_EXCL);
    }
    await writeFile(join(staging, 'catalog.json'), JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2) + '\n', { mode: 0o600 });
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
  const catalog = JSON.parse(await readFile(join(backup, 'catalog.json'), 'utf8'));
  if (catalog.version !== 1 || !Array.isArray(catalog.items)) throw new Error('Unsupported backup catalog.');
  await mkdir(join(destination, 'media'), { recursive: true, mode: 0o700 });
  const db = openCatalog(destination);
  let count = 0;
  try {
    for (const item of catalog.items) {
      if (!item || !MEDIA_ID.test(item.id) || !Object.hasOwn(formats, item.mime) ||
          !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_FILE ||
          !Number.isSafeInteger(item.created) || !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
          typeof item.title !== 'string' || typeof item.name !== 'string') throw new Error('Invalid backup media record.');
      const original = join(backup, 'media', item.id);
      if ((await stat(original)).size !== item.size) throw new Error('Invalid backup file size.');
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
          await rename(staging, restored);
        } finally {
          await rm(staging, { force: true });
        }
      }
      db.prepare(`INSERT INTO media (id, title, name, mime, size, fingerprint, status, created)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', ?) ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, name = excluded.name, mime = excluded.mime, size = excluded.size,
        fingerprint = excluded.fingerprint, status = 'ready', created = excluded.created, version = media.version + 1`)
        .run(item.id, item.title, item.name, item.mime, item.size, item.fingerprint, item.created);
      count++;
    }
    return count;
  } finally {
    db.close();
  }
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  const [command, directory] = process.argv.slice(2);
  const dataDir = process.env.STILLROOM_DATA_DIR || join(dirname(filename), '.data');
  try {
    if (!directory || !['export', 'restore'].includes(command)) throw new Error('Usage: npm run backup -- export|restore /path/to/backup');
    const count = await (command === 'export' ? exportBackup : restoreBackup)(dataDir, directory);
    console.log((command === 'export' ? 'Backed up ' : 'Restored ') + count + ' media item(s).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
