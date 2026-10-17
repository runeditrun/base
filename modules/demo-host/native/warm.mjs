import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { HASHED_ASSET } from './config.mjs';

// The start page prefetches the console's hashed JS and CSS while the visitor
// waits for the human check and sign-in, so each view's first visit finds its
// chunks in the browser's cache, and the colo holds them for the next visitor.
// At most WARM_BYTES of gzip-compressed transfer, the console first: the
// root and console layout, the console's own views (what its nav links to),
// its deeper views, the other routes, then the remaining chunks.
export const WARM_BYTES = 1024 * 1024;

const segments = path => path.split('/').filter(Boolean);
const dynamic = path => segments(path).filter(part => part.startsWith('$')).length;
const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/');

// TanStack Start's route manifest from the server build: each route's CSS and
// the chunks it preloads.
async function startRoutes(server) {
  const directory = join(server, 'assets');
  const file = (await readdir(directory).catch(() => [])).find(name => /^_tanstack-start-manifest_v-[\w-]+\.js$/.test(name));
  if (!file) return {};
  const { tsrStartManifest } = await import(pathToFileURL(join(directory, file)));
  return tsrStartManifest().routes ?? {};
}

function routeOrder(routes, consolePath) {
  const ids = Object.keys(routes).filter(id => id !== '__root__');
  const views = id => within(id, consolePath) && id !== consolePath;
  const nav = id => views(id) && !dynamic(id) && segments(id).length === segments(consolePath).length + 1 && !id.endsWith('_');
  const rank = id => [consolePath, consolePath + '/'].includes(id) ? 0 : nav(id) ? 1 : views(id) ? 2 : 3;
  const sorted = ids.sort((a, b) => rank(a) - rank(b) || dynamic(a) - dynamic(b) || segments(a).length - segments(b).length || a.localeCompare(b));
  return ['__root__', ...sorted].filter(id => routes[id]);
}

/** The ordered, size-capped paths the start page prefetches, from dist/client's files and the server build. */
export async function warmList(files, server, consolePath = '/app') {
  const sizes = new Map(files.map(file => ['/' + file.path, file]).filter(([path]) => HASHED_ASSET.test(path) && /\.(js|css)$/.test(path))
    .map(([path, file]) => [path, gzipSync(Buffer.from(file.base64, 'base64')).length]));
  const routes = await startRoutes(server);
  const ordered = new Set();
  for (const id of routeOrder(routes, consolePath)) for (const path of [...(routes[id].css ?? []), ...(routes[id].preloads ?? [])]) if (sizes.has(path)) ordered.add(path);
  for (const path of [...sizes.keys()].sort((a, b) => sizes.get(a) - sizes.get(b))) ordered.add(path);
  const warm = []; let bytes = 0;
  for (const path of ordered) if (bytes + sizes.get(path) <= WARM_BYTES) { warm.push(path); bytes += sizes.get(path); }
  return { paths: warm, bytes, of: sizes.size };
}
