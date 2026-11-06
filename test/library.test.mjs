import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
const password = 'a good local password';
const ownerEmail = 'owner@example.test';
const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function start(dataDir, now, storageLimit) {
  const { createApp } = await import('../server.mjs');
  const app = await createApp({ dataDir, ownerEmail, ownerPassword: password, chunkSize: 32, now, storageLimit });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const stop = () => app.close();
  cleanup.push(stop);
  function client() {
    let cookie;
    return async (path, options = {}) => {
      const headers = new Headers(options.headers);
      if (cookie) headers.set('cookie', cookie);
      let body = options.body;
      if (body && !Buffer.isBuffer(body)) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(body);
      }
      const response = await fetch(base + path, { ...options, body, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    };
  }
  return { client, stop };
}

async function workspace() {
  const dataDir = await mkdtemp(join(tmpdir(), 'stillroom-test-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function post(client, path, body) {
  return client(path, { method: 'POST', body });
}

async function ownerClient(app) {
  const owner = app.client();
  assert.equal((await post(owner, '/api/auth/login', { email: ownerEmail, password })).status, 200);
  return owner;
}

async function invite(owner, email) {
  const response = await post(owner, '/api/invites', { email });
  assert.equal(response.status, 201);
  return response.json();
}

function redeem(client, invitation) {
  const token = new URL(invitation.path, 'http://localhost').hash.slice(1);
  return post(client, '/api/auth/redeem', { token, password });
}

const metadata = { name: 'Tiny photo.png', mime: 'image/png', size: png.length, fingerprint: 'a'.repeat(64) };
async function openUpload(client, changes) {
  const response = await post(client, '/api/uploads', { ...metadata, ...changes });
  assert.ok([200, 201].includes(response.status));
  return response.json();
}

function sendChunk(client, id, offset, bytes) {
  return client('/api/uploads/' + id + '?offset=' + offset, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes
  });
}

async function finishUpload(client, item, bytes = png) {
  for (let offset = item.offset; offset < bytes.length; offset += 32) {
    assert.equal((await sendChunk(client, item.id, offset, bytes.subarray(offset, offset + 32))).status, 200);
  }
  return post(client, '/api/uploads/' + item.id + '/finish');
}

test('an invitation is single-use, only grants viewing, and revocation invalidates an existing session', async () => {
  const app = await start(await workspace());
  const owner = await ownerClient(app);
  const guest = app.client();
  const outsider = app.client();
  const invitation = await invite(owner, ' Guest@Example.test ');
  assert.equal((await guest('/api/media')).status, 401);
  assert.equal((await post(outsider, '/api/auth/login', { email: 'guest@example.test', password })).status, 401);
  assert.equal((await redeem(guest, invitation)).status, 200);
  assert.equal((await redeem(outsider, invitation)).status, 404);
  assert.equal((await guest('/api/media')).status, 200);
  assert.equal((await post(guest, '/api/uploads', metadata)).status, 403);
  assert.equal((await post(guest, '/api/invites', { email: 'other@example.test' })).status, 403);
  assert.equal((await owner('/api/invites/' + invitation.id, { method: 'DELETE' })).status, 200);
  assert.equal((await guest('/api/media')).status, 401);
  assert.equal((await post(guest, '/api/auth/login', { email: 'guest@example.test', password })).status, 401);
});

test('ten guest slots include active guests and pending invites, and a revoked slot can be reused', async () => {
  const app = await start(await workspace());
  const owner = await ownerClient(app);
  const first = await invite(owner, 'first@example.test');
  assert.equal((await redeem(app.client(), first)).status, 200);
  await Promise.all(Array.from({ length: 9 }, (_, index) => invite(owner, 'guest' + index + '@example.test')));
  assert.equal((await post(owner, '/api/invites', { email: 'eleven@example.test' })).status, 409);
  assert.equal((await owner('/api/invites/' + first.id, { method: 'DELETE' })).status, 200);
  await invite(owner, 'eleven@example.test');
});

test('an expired invitation frees its slot and cannot be used to create a guest session', async () => {
  let time = Date.now();
  const app = await start(await workspace(), () => time);
  const owner = await ownerClient(app);
  const invitation = await invite(owner, 'expired@example.test');
  time += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.equal((await redeem(app.client(), invitation)).status, 404);
  const freshOwner = await ownerClient(app);
  const access = await (await freshOwner('/api/owner')).json();
  assert.equal(access.used, 0);
  assert.equal(access.invites[0].status, 'expired');
  await invite(freshOwner, 'expired@example.test');
  assert.equal((await redeem(app.client(), invitation)).status, 404);
});

test('an interrupted upload resumes from disk after restart and finishes only once', async () => {
  const dataDir = await workspace();
  const app = await start(dataDir);
  const owner = await ownerClient(app);
  const upload = await openUpload(owner);
  assert.equal((await sendChunk(owner, upload.id, 0, png.subarray(0, 32))).status, 200);
  assert.equal((await sendChunk(owner, upload.id, 0, png.subarray(0, 32))).status, 409);
  assert.equal((await sendChunk(owner, upload.id, 32, png.subarray(32, 38))).status, 400);
  assert.equal((await post(owner, '/api/uploads/' + upload.id + '/finish')).status, 409);
  await app.stop();
  const restarted = await ownerClient(await start(dataDir));
  const resumed = await openUpload(restarted);
  assert.equal(resumed.id, upload.id);
  assert.equal(resumed.offset, 32);
  assert.equal((await finishUpload(restarted, resumed)).status, 200);
  assert.equal((await post(restarted, '/api/uploads/' + resumed.id + '/finish')).status, 200);
  assert.equal((await (await restarted('/api/media')).json()).items.length, 1);
});

test('private links serve exact byte ranges and stop working after guest revocation or trashing', async () => {
  const app = await start(await workspace());
  const owner = await ownerClient(app);
  const guest = app.client();
  const outsider = app.client();
  const invitation = await invite(owner, 'viewer@example.test');
  await redeem(guest, invitation);
  const upload = await openUpload(owner);
  assert.equal((await finishUpload(owner, upload)).status, 200);
  const route = '/api/media/' + upload.id;
  const { url } = await (await guest(route + '/link')).json();
  assert.equal((await outsider(url)).status, 401);
  assert.equal((await owner(url)).status, 403);
  const seek = await guest(url, { headers: { range: 'bytes=9-13' } });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get('content-range'), 'bytes 9-13/' + png.length);
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), png.subarray(9, 14));
  assert.equal((await guest(url, { headers: { range: 'bytes=99999-' } })).status, 416);
  assert.equal((await guest(route, { method: 'DELETE' })).status, 403);
  assert.equal((await owner(route, { method: 'DELETE' })).status, 200);
  assert.equal((await guest(url)).status, 404);
  assert.equal((await post(owner, route + '/restore')).status, 200);
  assert.equal((await guest(url)).status, 403);
  const restored = await (await guest(route + '/link')).json();
  assert.equal((await guest(restored.url)).status, 200);
  assert.equal((await owner('/api/invites/' + invitation.id, { method: 'DELETE' })).status, 200);
  assert.equal((await guest(restored.url)).status, 401);
  assert.equal((await guest(route + '/link')).status, 401);
});

test('free-tier capacity reserves the entire file atomically and survives a restart', async () => {
  const dataDir = await workspace();
  const app = await start(dataDir, undefined, png.length);
  const owner = await ownerClient(app);
  const secondFile = { ...metadata, name: 'Another photo.png', fingerprint: 'b'.repeat(64) };
  const responses = await Promise.all([
    post(owner, '/api/uploads', metadata),
    post(owner, '/api/uploads', secondFile)
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const allowed = responses.findIndex(response => response.status === 201);
  const admitted = await responses[allowed].json();
  const rejected = await responses[1 - allowed].json();
  assert.equal(rejected.code, 'storage_limit');
  assert.equal(rejected.available, 0);

  await app.stop();
  const reopened = await ownerClient(await start(dataDir, undefined, png.length));
  const { usage } = await (await reopened('/api/owner')).json();
  assert.equal(usage.limit, png.length);
  assert.equal(usage.reserved, png.length);
  assert.equal(usage.available, 0);
  const resumed = await openUpload(reopened, allowed === 0 ? metadata : secondFile);
  assert.equal(resumed.id, admitted.id);
  assert.equal((await reopened('/api/uploads/' + admitted.id, { method: 'DELETE' })).status, 200);
  assert.equal((await post(reopened, '/api/uploads', allowed === 0 ? secondFile : metadata)).status, 201);
});

test('moving an original to Trash only frees capacity after permanent deletion', async () => {
  const owner = await ownerClient(await start(await workspace(), undefined, png.length));
  const upload = await openUpload(owner);
  assert.equal((await finishUpload(owner, upload)).status, 200);
  const route = '/api/media/' + upload.id;
  const secondFile = { ...metadata, name: 'Another photo.png', fingerprint: 'b'.repeat(64) };
  assert.equal((await owner(route, { method: 'DELETE' })).status, 200);
  assert.equal((await post(owner, '/api/uploads', secondFile)).status, 409);
  const { usage } = await (await owner('/api/owner')).json();
  assert.equal(usage.trash, png.length);
  assert.equal(usage.available, 0);
  assert.equal((await post(owner, route + '/restore')).status, 200);
  assert.equal((await owner(route, { method: 'DELETE' })).status, 200);
  assert.equal((await owner(route + '/purge', { method: 'DELETE' })).status, 200);
  assert.equal((await post(owner, '/api/uploads', secondFile)).status, 201);
});

test('the production default rejects new storage reservations over nine decimal GB', async () => {
  const owner = await ownerClient(await start(await workspace()));
  await openUpload(owner, { size: 4_000_000_000 });
  await openUpload(owner, { size: 4_000_000_000, fingerprint: 'b'.repeat(64) });
  const exact = { ...metadata, size: 1_000_000_000, fingerprint: 'c'.repeat(64) };
  assert.equal((await post(owner, '/api/uploads', exact)).status, 201);
  assert.equal((await post(owner, '/api/uploads', { ...metadata, size: 1 })).status, 409);
});

test('an old reservation above the limit cannot write more bytes until space is freed', async () => {
  const dataDir = await workspace();
  const app = await start(dataDir, undefined, png.length * 2);
  const owner = await ownerClient(app);
  const first = await openUpload(owner);
  const second = await openUpload(owner, { fingerprint: 'd'.repeat(64) });
  await app.stop();

  const reopened = await ownerClient(await start(dataDir, undefined, png.length));
  assert.equal((await sendChunk(reopened, first.id, 0, png.subarray(0, 32))).status, 409);
  assert.equal((await reopened('/api/uploads/' + second.id, { method: 'DELETE' })).status, 200);
  assert.equal((await sendChunk(reopened, first.id, 0, png.subarray(0, 32))).status, 200);
});

test('declared file type is checked against the bytes before an upload appears in the library', async () => {
  const owner = await ownerClient(await start(await workspace()));
  const bytes = Buffer.alloc(png.length);
  const upload = await openUpload(owner);
  assert.equal((await finishUpload(owner, upload, bytes)).status, 415);
  assert.deepEqual((await (await owner('/api/media')).json()).items, []);
});

test('the backup command copies originals and restores a deleted item into a fresh library', async () => {
  const dataDir = await workspace();
  const restoreDir = await workspace();
  const backupDir = join(await workspace(), 'backup');
  const app = await start(dataDir);
  const owner = await ownerClient(app);
  const upload = await openUpload(owner);
  await finishUpload(owner, upload);
  await app.stop();
  const { exportBackup, restoreBackup } = await import('../backup.mjs');
  await exportBackup(dataDir, backupDir);
  const reopened = await start(dataDir);
  const reopenedOwner = await ownerClient(reopened);
  const route = '/api/media/' + upload.id;
  assert.equal((await reopenedOwner(route, { method: 'DELETE' })).status, 200);
  assert.equal((await reopenedOwner(route + '/purge', { method: 'DELETE' })).status, 200);
  assert.equal((await post(reopenedOwner, route + '/restore')).status, 404);
  await reopened.stop();
  assert.equal(await restoreBackup(dataDir, backupDir), 1);
  const full = await start(restoreDir);
  const fullOwner = await ownerClient(full);
  await openUpload(fullOwner, { size: 4_000_000_000 });
  await openUpload(fullOwner, { size: 4_000_000_000, fingerprint: 'b'.repeat(64) });
  await openUpload(fullOwner, { size: 1_000_000_000, fingerprint: 'c'.repeat(64) });
  await assert.rejects(restoreBackup(restoreDir, backupDir), { details: { code: 'storage_limit', limit: 9_000_000_000, available: 0 } });
  assert.deepEqual((await (await fullOwner('/api/media')).json()).items, []);
  const { pending } = await (await fullOwner('/api/owner')).json();
  for (const item of pending) assert.equal((await fullOwner('/api/uploads/' + item.id, { method: 'DELETE' })).status, 200);
  await full.stop();
  assert.equal(await restoreBackup(restoreDir, backupDir), 1);
  const restored = await ownerClient(await start(restoreDir));
  const { items } = await (await restored('/api/media')).json();
  assert.equal(items[0].title, 'Tiny photo');
  const { url } = await (await restored('/api/media/' + items[0].id + '/link')).json();
  assert.deepEqual(Buffer.from(await (await restored(url)).arrayBuffer()), png);
  assert.equal(await restoreBackup(restoreDir, backupDir), 0);
});

test('the local shell and its scripts are available without cloud credentials', async () => {
  const browser = (await start(await workspace())).client();
  const shell = await browser('/');
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Stillroom/);
  assert.equal((await browser('/app.js')).status, 200);
  const galleryModule = await browser('/gallery.mjs');
  assert.equal(galleryModule.status, 200);
  assert.match(galleryModule.headers.get('content-type'), /javascript/);
  assert.equal((await browser('/.data/catalog.sqlite')).status, 404);
});
