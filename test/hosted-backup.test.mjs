import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportHostedBackup } from '../hosted-backup.mjs';
import { restoreBackup } from '../backup.mjs';
import { openCatalog } from '../catalog.mjs';

const origin = 'https://stillroom.example.test';
const id = '12345678-0000-0000-0000-000000000000';
const collectionId = '22345678-0000-0000-0000-000000000000';
const token = 'A'.repeat(43);
const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
const media = { id, name:'Test.png', title:'Backup test', mime:'image/png', size:bytes.length,
  created:1_700_000_000_000, description:'📷'.repeat(2000), favourite:true, collectionId };
const collection = { id:collectionId, name:'\u00a0' + '📷'.repeat(79) };
const catalog = { items:[media], collections:[collection] };

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stillroom-hosted-backup-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  return directory;
}

function transport({ role = 'owner', mediaBytes = bytes, changed = false } = {}) {
  let fetchedCatalog = false;
  let signedOut = false;
  const fetch = async (url, options) => {
    const route = new URL(url);
    assert.equal(route.origin, origin);
    assert.equal(options.redirect, 'error');
    if (route.pathname === '/api/auth/login') {
      return Response.json({user:{role}}, { headers:{'set-cookie':'__Host-stillroom='+token+'; Secure; HttpOnly'} });
    }
    assert.equal(new Headers(options.headers).get('cookie'), '__Host-stillroom='+token);
    if (route.pathname === '/api/auth/logout') {
      signedOut = true;
      return Response.json({});
    }
    if (route.pathname === '/api/media') {
      const body = fetchedCatalog && changed ? { ...catalog, items:[{...media, title:'Changed'}] } : catalog;
      fetchedCatalog = true;
      return Response.json(body);
    }
    assert.equal(route.pathname, '/api/media/'+id+'/content');
    return new Response(mediaBytes, { headers:{'content-type':'image/png'} });
  };
  return { fetch, signedOut: () => signedOut };
}

function exportWith(destination, server) {
  return exportHostedBackup(destination, { origin, email:'owner@example.test', password:'a synthetic password', fetch:server.fetch });
}

test('a hosted export restores the original bytes and catalog details into an isolated library', async t => {
  const dir = await workspace(t);
  const backup = join(dir,'backup');
  const restored = join(dir,'restored');
  const server = transport();
  assert.equal(await exportWith(backup,server),1);
  assert.equal(server.signedOut(),true);
  const manifest = JSON.parse(await readFile(join(backup,'catalog.json'),'utf8'));
  assert.equal(manifest.items[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(await restoreBackup(restored,backup),1);
  if (process.platform !== 'win32') assert.equal((await stat(restored)).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(join(restored,'media',id)),bytes);
  const db = openCatalog(restored);
  try {
    assert.deepEqual({...db.prepare('select title, description, favourite, collection_id from media where id = ?').get(id)},
      {title:media.title,description:media.description,favourite:1,collection_id:collectionId});
    assert.equal(db.prepare('select name from collections where id = ?').get(collectionId).name,collection.name);
  } finally { db.close(); }
  await assert.rejects(restoreBackup(restored,backup),/new restore directory/i);
});

test('same-size corruption fails checksum verification without publishing a restored library', async t => {
  const dir = await workspace(t);
  const backup = join(dir,'backup');
  const restored = join(dir,'restored');
  await exportWith(backup,transport());
  const corrupted = Buffer.from(bytes);
  corrupted[10] ^= 1;
  await writeFile(join(backup,'media',id),corrupted);
  await assert.rejects(restoreBackup(restored,backup),/checksum/i);
  await assert.rejects(readFile(join(restored,'catalog.sqlite')),{code:'ENOENT'});
});

test('a hosted restore rejects a backup whose media directory points outside the backup', { skip:process.platform === 'win32' }, async t => {
  const dir = await workspace(t);
  const backup = join(dir,'backup');
  const restored = join(dir,'restored');
  const outside = join(dir,'outside');
  await exportWith(backup,transport());
  await rename(join(backup,'media'),outside);
  await symlink(outside,join(backup,'media'),'dir');
  await assert.rejects(restoreBackup(restored,backup),/media directory/i);
  await assert.rejects(stat(restored),{code:'ENOENT'});
});

test('partial or invalid downloads, guest sessions and a changing catalog leave no completed backup', async t => {
  const dir = await workspace(t);
  for (const [name, server, pattern] of [
    ['short',transport({mediaBytes:bytes.subarray(0,-1)}),/incomplete/i],
    ['malformed',transport({mediaBytes:Buffer.alloc(bytes.length)}),/format/i],
    ['guest',transport({role:'guest'}),/owner/i],
    ['changed',transport({changed:true}),/changed/i]
  ]) {
    const backup = join(dir,name);
    await assert.rejects(exportWith(backup,server),pattern);
    assert.equal(server.signedOut(),true);
    await assert.rejects(readFile(join(backup,'catalog.json')),{code:'ENOENT'});
  }
});
