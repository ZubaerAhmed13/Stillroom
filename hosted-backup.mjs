import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { formats, hasMediaSignature, MAX_FILE } from './media-format.mjs';
import { MEDIA_ID } from './media.mjs';

export const HOSTED_ORIGIN = 'https://stillroom-pilot.zubaerahmed13.workers.dev';

export function backupCollectionName(name) {
  if (typeof name !== 'string' || !/[^ ]/.test(name) || [...name].length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Invalid backup collection name.');
  }
  return name;
}

export function validBackupDescription(description) {
  return typeof description === 'string' && [...description].length <= 2000;
}

function backupOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the HTTPS origin of the Stillroom library.');
  }
  return url.origin;
}

function snapshot(data) {
  if (!Array.isArray(data?.collections) || !Array.isArray(data?.items)) throw new Error('Invalid hosted catalog.');
  const collections = new Map();
  for (const c of data.collections) {
    if (!c || typeof c.id !== 'string' || !MEDIA_ID.test(c.id) || collections.has(c.id)) throw new Error('Invalid hosted collection.');
    collections.set(c.id, { id: c.id, name: backupCollectionName(c.name) });
  }
  const items = new Map();
  for (const item of data.items) {
    if (!item || typeof item.id !== 'string' || !MEDIA_ID.test(item.id) || items.has(item.id) ||
        !Object.hasOwn(formats, item.mime) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_FILE ||
        typeof item.name !== 'string' || typeof item.title !== 'string' || !Number.isSafeInteger(item.created) ||
        !validBackupDescription(item.description) || typeof item.favourite !== 'boolean' ||
        (item.collectionId !== null && !collections.has(item.collectionId))) {
      throw new Error('Invalid hosted media record.');
    }
    const { id, name, title, mime, size, created, description, favourite, collectionId } = item;
    items.set(id, { id, name, title, mime, size, created, description, favourite: Number(favourite), collectionId });
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  return { collections: [...collections.values()].sort(byId), items: [...items.values()].sort(byId) };
}

async function download(response, target, item) {
  if (response.status !== 200 || !response.body) throw new Error('Stillroom did not return a complete original.');
  if (response.headers.get('content-type')?.split(';')[0] !== item.mime) {
    await response.body.cancel();
    throw new Error('The original has an unexpected file format.');
  }
  const hash = createHash('sha256');
  const signature = new Uint8Array(Math.min(item.size, 128));
  let size = 0;
  const verify = new Transform({
    transform(chunk, encoding, done) {
      if (size < signature.length) signature.set(chunk.subarray(0, signature.length - size), size);
      size += chunk.length;
      if (size > item.size) return done(new Error('The original exceeds its catalog size.'));
      hash.update(chunk);
      done(null, chunk);
    }
  });
  await pipeline(response.body, verify, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  if (size !== item.size) throw new Error('The original download is incomplete.');
  if (!hasMediaSignature(signature, item.mime)) throw new Error('The original has an invalid file format.');
  return hash.digest('hex');
}

export async function exportHostedBackup(target, { origin = HOSTED_ORIGIN, email, password, fetch: transport = fetch, signal } = {}) {
  const base = backupOrigin(origin);
  const destination = resolve(target);
  try {
    await lstat(destination);
    throw new Error('The backup directory already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    throw new Error('Enter your Stillroom owner email and password.');
  }
  const staging = join(dirname(destination), '.stillroom-backup-' + randomUUID());
  let cookie;
  async function call(path, method = 'GET', body, requestSignal = signal) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers.origin = base;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await transport(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: requestSignal
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Stillroom returned HTTP ' + response.status + ' while requesting ' + path.split('/').slice(0, 3).join('/') + '.');
    }
    return response;
  }

  try {
    const login = await call('/api/auth/login', 'POST', { email, password });
    const value = /^__Host-stillroom=([A-Za-z0-9_-]{43})(?:;|$)/.exec(login.headers.get('set-cookie') || '');
    if (!value) throw new Error('Stillroom did not issue a session.');
    cookie = '__Host-stillroom=' + value[1];
    if ((await login.json()).user?.role !== 'owner') throw new Error('An owner account is required to export a backup.');
    const catalog = snapshot(await (await call('/api/media')).json());
    await mkdir(staging, { mode: 0o700 });
    await mkdir(join(staging, 'media'), { mode: 0o700 });
    const entries = [];
    for (const item of catalog.items) {
      const sha256 = await download(await call('/api/media/' + item.id + '/content'), join(staging, 'media', item.id), item);
      entries.push({ ...item, fingerprint: sha256, sha256 });
    }
    const current = snapshot(await (await call('/api/media')).json());
    if (JSON.stringify(current) !== JSON.stringify(catalog)) {
      throw new Error('The hosted catalog changed during the backup. Try again after editing and uploads finish.');
    }
    const manifest = { version: 3, exportedAt: new Date().toISOString(), collections: catalog.collections, items: entries };
    await writeFile(join(staging, 'catalog.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(staging, destination);
    return entries.length;
  } finally {
    if (cookie) {
      try { await (await call('/api/auth/logout', 'POST', undefined, AbortSignal.timeout(5000))).body?.cancel(); }
      catch { /* The temporary session credential is only held in memory. */ }
    }
    await rm(staging, { recursive: true, force: true });
  }
}
