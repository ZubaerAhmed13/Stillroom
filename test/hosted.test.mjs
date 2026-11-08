import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostedWorker } from '../hosted/worker.mjs';

const origin = 'https://stillroom.example.test';
const token = 'A'.repeat(43);
const bridgeKey = 'B'.repeat(43);
const owner = { email: 'owner@example.test', role: 'owner' };
const env = { STILLROOM_ORIGIN: origin, SUPABASE_URL: 'https://db.example.test', STILLROOM_BRIDGE_KEY: bridgeKey };

function harness(handleBridge) {
  const worker = createHostedWorker(async (url, options) => {
    assert.equal(url, env.SUPABASE_URL + '/functions/v1/stillroom-bridge');
    assert.equal(options.headers['x-stillroom-bridge'], bridgeKey);
    const body = JSON.parse(options.body);
    return handleBridge(body);
  });
  return (path, options) => worker.fetch(new Request(origin + path, options), env);
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
