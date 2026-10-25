import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dependencies = resolve(import.meta.dirname, '../../default-seed/node_modules');
const require = createRequire(join(dependencies, '../package.json'));
const { createElement: h, Suspense } = require('react');
const { renderToString } = require('react-dom/server');
const { build } = require('esbuild');

// Real server markup and a bundled React client, served through the same built
// Worker/assets door as verify. The unresolved boundary retains server DOM.
export async function hydrationSeed(t, { neverHydrates = false, replaceServer = false, removeServer = false } = {}) {
 const root = await mkdtemp(join(tmpdir(), 'rer-hydration-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, 'dist/server'), { recursive: true });
 await mkdir(join(root, 'dist/client'), { recursive: true });
 await symlink(dependencies, join(root, 'node_modules'));
 await writeFile(join(root, 'package.json'), '{"type":"module"}');
 await writeFile(join(root, 'deploy.json'), '{"version":1,"vars":{}}');
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', compatibility_date: '2026-09-08', assets: { directory: '../client' } }));
 const content = h('main', null, h(Suspense, { fallback: null }, h('p', { id: 'server' }, 'Support is available')));
 const html = '<!DOCTYPE html>' + renderToString(h('html', null, h('head'), h('body', null, content, h('script', { type: 'module', src: '/client.js' }))));
 await writeFile(join(root, 'dist/server/index.js'), `export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/client.js') return env.ASSETS.fetch(request);
  return new Response(${JSON.stringify(html)}, { headers: { 'content-type': 'text/html', 'cache-control': 'no-transform' } });
 } };`);
 await build({ stdin: { contents: `
  import { createElement as h, Suspense, useEffect } from 'react';
  import { hydrateRoot } from 'react-dom/client';
  const waiting = new Promise(() => {});
  function Content() { ${neverHydrates ? 'throw waiting;' : "return h('p', { id: 'server' }, 'Support is available');"} }
  function App() {
   useEffect(() => {
    if (${replaceServer}) {
     const server = document.getElementById('server');
     const replacement = server.cloneNode(true);
     server.replaceWith(replacement);
     document.body.append(replacement);
    }
    if (${removeServer}) document.getElementById('server').remove();
    if (${neverHydrates}) return;
    const tooltip = document.createElement('div');
    tooltip.className = 'ui-tooltip';
    document.body.append(tooltip);
    return () => tooltip.remove();
   }, []);
   return h('html', null, h('head'), h('body', null,
    h('main', null, h(Suspense, { fallback: null }, h(Content))),
    h('script', { type: 'module', src: '/client.js' })));
  }
  hydrateRoot(document, h(App));
 `, resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/client/client.js') });
 return root;
}
