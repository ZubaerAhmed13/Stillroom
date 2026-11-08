import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostedWorker } from '../hosted/worker.mjs';

const origin = 'https://stillroom.example.test';
const token = 'A'.repeat(43);
const bridgeKey = 'B'.repeat(43);
const owner = { email: 'owner@example.test', role: 'owner' };
const env = { STILLROOM_ORIGIN: origin, SUPABASE_URL: 'https://db.example.test', STILLROOM_BRIDGE_KEY: bridgeKey };

function harness(handleBridge, bindings = {}) {
  const worker = createHostedWorker(async (url, options) => {
    assert.equal(url, env.SUPABASE_URL + '/functions/v1/stillroom-bridge');
    assert.equal(options.headers['x-stillroom-bridge'], bridgeKey);
    const body = JSON.parse(options.body);
    return handleBridge(body);
  });
  return (path, options) => worker.fetch(new Request(origin + path, options), { ...env, ...bindings });
}

function post(body, headers = {}) {
  return { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

test('hosted sign-in sets a private session cookie without returning the credential', async () => {
  const call = harness(body => {
    assert.equal(body.action, 'login');
    assert.equal(body.data.email, owner.email);
    return Response.json({ user: owner, token });
  });
  const response = await call('/api/auth/login', post({ email: owner.email, password: 'a synthetic password' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: owner });
  assert.match(response.headers.get('set-cookie'), new RegExp('^__Host-stillroom=' + token + ';'));
  assert.match(response.headers.get('set-cookie'), /; Secure; HttpOnly; SameSite=Strict/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('cross-origin writes and anonymous protected requests never reach the bridge', async () => {
  const call = harness(() => assert.fail('The request reached Supabase'));
  assert.equal((await call('/api/auth/login', post({}, { origin: 'https://foreign.example.test' }))).status, 403);
  assert.equal((await call('/api/media')).status, 401);
  assert.deepEqual(await (await call('/api/session')).json(), { user: null });
});

test('a session is checked on every protected request and provider failures stop access', async () => {
  let nextStatus = 200;
  const call = harness(body => {
    assert.equal(body.action, 'media');
    assert.equal(body.session, token);
    return nextStatus === 200 ? Response.json({ items: [], collections: [] }) :
      Response.json({ error: 'Sign in to continue.' }, { status: nextStatus });
  });
  const options = { headers: { cookie: '__Host-stillroom=' + token } };
  assert.equal((await call('/api/media', options)).status, 200);
  nextStatus = 401;
  assert.equal((await call('/api/media', options)).status, 401);
  nextStatus = 502;
  assert.equal((await call('/api/media', options)).status, 503);
});

test('media transfer stays disabled in the hosted sign-in preview', async () => {
  const call = harness(body => {
    assert.equal(body.action, 'require_owner');
    return Response.json({});
  });
  const result = await call('/api/uploads', post({}, { cookie: '__Host-stillroom=' + token }));
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, 'media_paused');
});

const mediaId = '12345678-0000-0000-0000-000000000000';
const authenticated = { cookie: '__Host-stillroom=' + token };
const enabled = bucket => ({ STILLROOM_MEDIA_ENABLED: 'true', MEDIA: bucket });

test('range reads use a private object and stop before R2 when the ledger rejects the request', async () => {
  let rejectRead = false;
  let reads = 0;
  const call = harness(({ action, data }) => {
    assert.equal(action, 'storage_read');
    assert.equal(data.id, mediaId);
    if (rejectRead) return Response.json({ error: 'Read limit reached.', code: 'r2_read_limit' }, { status: 429 });
    return Response.json({ mime: 'video/mp4', size: 10 });
  }, enabled({ async get(key, options) {
    reads++;
    assert.equal(key, 'media/' + mediaId);
    assert.deepEqual(options.range, { offset: 2, length: 3 });
    return { size: 10, body: new Response('234').body };
  } }));
  const path = '/api/media/' + mediaId + '/content';
  const options = { headers: { ...authenticated, range: 'bytes=2-4' } };
  const response = await call(path, options);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), '234');
  rejectRead = true;
  assert.equal((await call(path, options)).status, 429);
  assert.equal(reads, 1);
});

test('hosted multipart writes count creation and part work before storing the bytes', async () => {
  const steps = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const call = harness(({ action, data }) => {
    steps.push(action);
    if (action === 'storage_part') {
      assert.equal(data.length, png.length);
      assert.match(data.hash, /^[a-f0-9]{64}$/);
      return Response.json({ mime: 'image/png', uploadId: null, partNumber: 1 });
    }
    if (action === 'storage_save_multipart') assert.equal(data.uploadId, 'upload-1');
    if (action === 'storage_save_part') return Response.json({ offset: 8 });
    return Response.json({});
  }, enabled({
    async createMultipartUpload(key, options) {
      steps.push('create');
      assert.equal(key, 'media/' + mediaId);
      assert.equal(options.storageClass, 'Standard');
      return { uploadId: 'upload-1', async uploadPart(number, body) {
        steps.push('part');
        assert.equal(number, 1);
        assert.deepEqual(Buffer.from(body), png);
        return { partNumber: 1, etag: 'etag-1' };
      } };
    }
  }));
  const response = await call('/api/uploads/' + mediaId + '?offset=0', {
    method: 'PUT', headers: { origin, ...authenticated, 'content-type': 'application/octet-stream' }, body: png
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { offset: 8 });
  assert.deepEqual(steps, ['require_owner', 'storage_part', 'create', 'storage_save_multipart', 'part', 'storage_save_part']);
});

test('an unauthorized upload is rejected before hashing or touching R2', async () => {
  const call = harness(({ action }) => {
    assert.equal(action, 'require_owner');
    return Response.json({ error: 'Only the owner can do this.' }, { status: 403 });
  }, enabled({}));
  const response = await call('/api/uploads/' + mediaId + '?offset=0', {
    method: 'PUT', headers: { origin, ...authenticated, 'content-type': 'application/octet-stream' }
  });
  assert.equal(response.status, 403);
});

test('canceling an expired multipart upload releases capacity only after deleting the object', async () => {
  const steps = [];
  const call = harness(({ action }) => {
    steps.push(action);
    return Response.json(action === 'storage_remove' ? { uploadId: 'expired-upload' } : {});
  }, enabled({
    resumeMultipartUpload() {
      return { async abort() {
        steps.push('abort');
        throw new Error('abortMultipartUpload: Multipart upload does not exist or was aborted. (10024)');
      } };
    },
    async delete(key) { assert.equal(key, 'media/' + mediaId); steps.push('delete'); }
  }));
  const response = await call('/api/uploads/' + mediaId, { method: 'DELETE', headers: { origin, ...authenticated } });
  assert.equal(response.status, 200);
  assert.deepEqual(steps, ['storage_remove', 'abort', 'delete', 'storage_removed']);
});

test('finishing after a lost response publishes an existing complete object without completing it twice', async () => {
  const steps = [];
  const call = harness(({ action }) => {
    steps.push(action);
    return Response.json(action === 'storage_finish' ? { uploadId: 'done', size: 8, parts: [] } : { id: mediaId });
  }, enabled({ async head(key) {
    assert.equal(key, 'media/' + mediaId);
    steps.push('head');
    return { size: 8 };
  } }));
  const response = await call('/api/uploads/' + mediaId + '/finish', { method: 'POST', headers: { origin, ...authenticated } });
  assert.equal(response.status, 200);
  assert.deepEqual(steps, ['storage_finish', 'head', 'storage_publish']);
});
