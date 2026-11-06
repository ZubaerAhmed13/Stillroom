import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openAccess } from './access.mjs';
import { openCatalog } from './catalog.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { openLocalMedia } from './local-media.mjs';
import { MEDIA_ID, MAX_FILE, openMedia } from './media.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const pages = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/invite', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/gallery.mjs', ['gallery.mjs', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);
const writeMethods = new Set(['POST', 'PUT', 'DELETE']);

function guardOrigin(request) {
  if (!writeMethods.has(request.method)) return;
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') throw new HttpError(403, 'Cross-origin request rejected.');
  if (!site && request.headers.origin) {
    let originHost;
    try { originHost = new URL(request.headers.origin).host; } catch { /* rejected below */ }
    if (!originHost || originHost !== request.headers.host) throw new HttpError(403, 'Cross-origin request rejected.');
  }
}

export async function createApp({
  dataDir = join(root, '.data'), ownerEmail = 'owner@stillroom.test', ownerPassword,
  secureCookies = false, now = Date.now, chunkSize = 8 * 1024 * 1024,
  storageLimit, onBootstrap = () => {}
} = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db = openCatalog(dataDir);
  let access, media;
  try {
    access = await openAccess(db, { ownerEmail, ownerPassword, secureCookies, now, onBootstrap });
    media = openMedia(db, await openLocalMedia(dataDir), { chunkSize, now, storageLimit });
  } catch (error) {
    db.close();
    throw error;
  }

  async function dispatch(request, response) {
    guardOrigin(request);
    const url = new URL(request.url, 'http://localhost');
    const { pathname, searchParams } = url;
    const { method } = request;
    const action = method + ' ' + pathname;

    if (method === 'GET' && pages.has(pathname)) {
      const [name, type] = pages.get(pathname);
      const bytes = await readFile(join(root, 'public', name));
      response.writeHead(200, { 'content-type': type, 'content-length': bytes.length });
      return response.end(bytes);
    }

    switch (action) {
      case 'GET /api/session': {
        const user = access.identity(request);
        return json(response, 200, { user: user ? { email: user.email, role: user.role } : null });
      }
      case 'POST /api/auth/login':
        return json(response, 200, { user: await access.login(request, response, await readJson(request)) });
      case 'POST /api/auth/redeem':
        return json(response, 200, { user: await access.redeem(request, response, await readJson(request)) });
      case 'POST /api/auth/logout':
        access.logout(request, response);
        return json(response, 200, {});
      case 'GET /api/media':
        access.requireUser(request);
        return json(response, 200, { items: media.list() });
      case 'GET /api/owner':
        access.requireUser(request, true);
        return json(response, 200, { ...access.invites(), trash: media.trash(), pending: await media.pending(), usage: media.usage(), maxFile: MAX_FILE });
      case 'POST /api/invites': {
        const owner = access.requireUser(request, true);
        return json(response, 201, access.invite((await readJson(request)).email, owner.email));
      }
      case 'POST /api/uploads': {
        access.requireUser(request, true);
        const { created, ...upload } = await media.start(await readJson(request));
        return json(response, created ? 201 : 200, upload);
      }
    }

    const [, api, collection, id, subresource, ...extra] = pathname.split('/');
    if (api !== 'api' || extra.length || !id || !MEDIA_ID.test(id)) throw new HttpError(404, 'Page not found.');
    if (collection === 'invites' && !subresource && method === 'DELETE') {
      access.requireUser(request, true);
      access.revoke(id);
      return json(response, 200, {});
    }
    if (collection === 'uploads') {
      access.requireUser(request, true);
      if (!subresource && method === 'PUT') return json(response, 200, await media.chunk(request, id, searchParams.get('offset')));
      if (subresource === 'finish' && method === 'POST') return json(response, 200, await media.finish(id));
      if (!subresource && method === 'DELETE') {
        await media.discard(id, 'uploading');
        return json(response, 200, {});
      }
    }
    if (collection === 'media') {
      const user = access.requireUser(request, writeMethods.has(method));
      if (subresource === 'link' && method === 'GET') return json(response, 200, media.link(id, user));
      if (subresource === 'content' && ['GET', 'HEAD'].includes(method)) return media.content(request, response, id, user, searchParams);
      if (!subresource && method === 'DELETE') {
        await media.move(id, 'ready', 'trashed');
        return json(response, 200, {});
      }
      if (subresource === 'restore' && method === 'POST') {
        await media.move(id, 'trashed', 'ready');
        return json(response, 200, {});
      }
      if (subresource === 'purge' && method === 'DELETE') {
        await media.discard(id, 'trashed');
        return json(response, 200, {});
      }
    }
    throw new HttpError(404, 'Page not found.');
  }

  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      await dispatch(request, response);
    } catch (error) {
      if (response.headersSent || response.destroyed) return response.destroy();
      if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
      json(response, error.status || 500, { error: error.status ? error.message : 'Something went wrong.', ...error.details });
    }
  });
  let closing;
  return {
    server,
    close() {
      if (!closing) closing = new Promise(resolveClose => server.close(() => { db.close(); resolveClose(); }));
      return closing;
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp({
    dataDir: process.env.STILLROOM_DATA_DIR,
    ownerEmail: process.env.STILLROOM_OWNER_EMAIL,
    ownerPassword: process.env.STILLROOM_OWNER_PASSWORD,
    secureCookies: process.env.STILLROOM_SECURE_COOKIES === '1',
    onBootstrap({ email, password }) {
      console.log('Local owner account created for ' + email + '.');
      if (password) console.log('Save this initial local password: ' + password);
    }
  });
  const { values } = parseArgs({ options: {
    host: { type: 'string' },
    port: { type: 'string' },
    strictPort: { type: 'boolean' }
  } });
  const host = values.host || process.env.HOST || '127.0.0.1';
  const port = Number(values.port || process.env.PORT || 4321);
  app.server.listen(port, host, () => console.log('Stillroom running at http://' + host + ':' + app.server.address().port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
}
