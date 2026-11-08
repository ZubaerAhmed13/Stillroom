import { readFile } from 'node:fs/promises';

const contentTypes = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'gallery.mjs': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'icon.svg': 'image/svg+xml'
};
const assets = {};
for (const [filename, type] of Object.entries(contentTypes)) {
  assets['/' + filename] = { type, body: await readFile(new URL('../public/' + filename, import.meta.url), 'utf8') };
}
const entrypoint = `import worker from './worker.mjs';
const files = ${JSON.stringify(assets)};
const ASSETS = {
  fetch(request) {
    const file = files[new URL(request.url).pathname];
    if (!file) return new Response('Page not found.', {status: 404});
    return new Response(request.method === 'HEAD' ? null : file.body, {
      headers: {'content-type': file.type}
    });
  }
};
export default { fetch(request, env) { return worker.fetch(request, {...env, ASSETS}); } };
`;
console.log(JSON.stringify({
  'index.mjs': entrypoint,
  'worker.mjs': await readFile(new URL('worker.mjs', import.meta.url), 'utf8')
}));
