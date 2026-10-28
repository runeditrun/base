import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from '../../../container/adapters/d1-workerd.mjs';
import { request as httpRequest } from 'node:http';

const root = new URL('../../', import.meta.url);
export async function createDevelopmentRuntime(path) {
  const modules = {};
  const add = async name => { modules[name] = { type: 'esm', contents: await readFile(new URL(name, root), 'utf8') }; };
  async function directory(name) {
    for (const entry of await readdir(new URL(name, root), { withFileTypes: true })) {
      if (entry.isDirectory()) await directory(`${name}/${entry.name}`);
      else if (entry.name.endsWith('.mjs')) await add(`${name}/${entry.name}`);
    }
  }
  await directory('src'); await add('index.mjs'); await add('tests/runtime/development-worker.mjs');
  return new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: path, workers: [{ config: {
    type: 'worker', name: 'mail-development', compatibilityDate: '2026-09-01',
    manifest: { mainModule: 'tests/runtime/development-worker.mjs', modulesRoot: fileURLToPath(root), modules },
    env: { DB: { type: 'd1', id: 'mail-development-outbox' } },
  } }] });
}

// Use actual HTTP ingress: dispatchFetch rewrites Host in this Miniflare version.
export async function developmentRequest(runtime, path, options = {}) {
  const url = new URL(path, await runtime.ready);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: { Host: url.host, ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('Local outbox HTTP test timed out')));
    request.end(options.body);
  });
}
