const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const cookieName = '__Host-stillroom';
const pages = new Map([
  ['/', 'index.html'], ['/invite', 'index.html'], ['/setup', 'index.html'],
  ['/app.js', 'app.js'], ['/gallery.mjs', 'gallery.mjs'],
  ['/style.css', 'style.css'], ['/icon.svg', 'icon.svg']
]);
const headers = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY'
};

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: { ...headers, ...extra } });
}

function cookie(value, age) {
  return cookieName + '=' + value + '; Path=/; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Strict';
}

function sessionFrom(request) {
  const pair = (request.headers.get('cookie') || '').split(';').map(entry => entry.trim())
    .find(entry => entry.startsWith(cookieName + '='));
  const value = pair?.slice(cookieName.length + 1);
  return tokenPattern.test(value || '') ? value : null;
}

async function readData(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, 'Expected JSON.');
  }
  const limit = 16 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new RequestError(413, 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'Expected a JSON object.');
  const decoder = new TextDecoder();
  let size = 0;
  let raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestError(413, 'The request is too large.');
      }
      raw += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  let data;
  try { data = JSON.parse(raw + decoder.decode()); }
  catch { throw new RequestError(400, 'Invalid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestError(400, 'Expected a JSON object.');
  return data;
}

export function createHostedWorker(transport = fetch) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const { pathname } = url;
        const { method } = request;
        if (url.origin !== env.STILLROOM_ORIGIN) throw new RequestError(404, 'Page not found.');
        if (['GET', 'HEAD'].includes(method) && pages.has(pathname)) {
          const asset = await env.ASSETS.fetch(new Request(new URL('/' + pages.get(pathname), url), { method }));
          const result = new Response(asset.body, asset);
          for (const [key, value] of Object.entries(headers)) result.headers.set(key, value);
          return result;
        }
        if (pathname === '/healthz' && method === 'GET') return json({ phase: 'sign-in-preview', mediaEnabled: false });
        if (!pathname.startsWith('/api/')) throw new RequestError(404, 'Page not found.');
        if (!['GET', 'HEAD'].includes(method) && (request.headers.get('origin') !== url.origin ||
            ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site')))) {
          throw new RequestError(403, 'Cross-origin request rejected.');
        }

        const session = sessionFrom(request);
        async function call(action, data = {}) {
          if (!tokenPattern.test(env.STILLROOM_BRIDGE_KEY || '')) throw new RequestError(503, 'Stillroom sign-in is temporarily unavailable.');
          const response = await transport(env.SUPABASE_URL + '/functions/v1/stillroom-bridge', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-stillroom-bridge': env.STILLROOM_BRIDGE_KEY },
            body: JSON.stringify({ action, session, data }),
            signal: AbortSignal.timeout(15000)
          });
          const result = await response.json();
          if (!response.ok) {
            if (response.status >= 500 || typeof result.error !== 'string') throw new RequestError(503, 'Stillroom is temporarily unavailable. Try again shortly.');
            throw new RequestError(response.status, result.error, result.code);
          }
          return result;
        }

        if (pathname === '/api/session' && method === 'GET') return json(session ? await call('session') : { user: null });
        if (pathname === '/api/auth/logout' && method === 'POST') {
          if (session) await call('logout');
          return json({}, 200, { 'set-cookie': cookie('', 0) });
        }
        const auth = /^\/api\/auth\/(login|redeem|setup)$/.exec(pathname);
        if (auth && method === 'POST') {
          const data = await readData(request);
          const { user, token } = await call(auth[1], { ...data, ip: request.headers.get('cf-connecting-ip') || 'unknown' });
          if (!user || !tokenPattern.test(token || '')) throw new RequestError(503, 'Stillroom sign-in is temporarily unavailable.');
          return json({ user }, 200, { 'set-cookie': cookie(token, 604800) });
        }

        if (!session) throw new RequestError(401, 'Sign in to continue.');
        if (pathname === '/api/media' && method === 'GET') return json(await call('media'));
        if (pathname === '/api/owner' && method === 'GET') return json(await call('owner'));
        if (pathname === '/api/invites' && method === 'POST') return json(await call('invite', await readData(request)), 201);
        if (pathname === '/api/collections' && method === 'POST') return json(await call('create_collection', await readData(request)), 201);
        const [, , resource, id, subresource] = pathname.split('/');
        if (idPattern.test(id || '') && !subresource && pathname === '/api/' + resource + '/' + id) {
          if (resource === 'invites' && method === 'DELETE') return json(await call('revoke', { id }));
          if (resource === 'collections' && method === 'PATCH') return json(await call('rename_collection', { ...(await readData(request)), id }));
          if (resource === 'media' && method === 'PATCH') return json(await call('edit_media', { ...(await readData(request)), id }));
        }
        if (/^\/api\/(uploads(?:\/|$)|media\/)/.test(pathname)) {
          await call(method === 'GET' || method === 'HEAD' ? 'require_member' : 'require_owner');
          throw new RequestError(503, 'Hosted media transfer is paused while the storage safeguards are being verified.', 'media_paused');
        }
        throw new RequestError(404, 'Page not found.');
      } catch (error) {
        if (error instanceof RequestError) return json({ error: error.message, code: error.code }, error.status);
        return json({ error: 'Stillroom is temporarily unavailable. Try again shortly.' }, 503);
      }
    }
  };
}

export default createHostedWorker();
