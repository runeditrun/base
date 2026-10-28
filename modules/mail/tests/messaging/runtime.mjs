import { installD1Preflight } from '../../../container/adapters/d1-workerd-setup.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const miniflare = await import(process.env.MAIL_MINIFLARE_MODULE || 'miniflare');
installD1Preflight(miniflare.D1_PLUGIN);
const { Miniflare } = miniflare;
const root = new URL('../../', import.meta.url);
export async function createRuntime(path, source, now) {
  const modules = {};
  async function add(name) { modules[name] = { type: 'esm', contents: await readFile(new URL(name, root), 'utf8') }; }
  async function visit(name) {
    for (const item of await readdir(new URL(name, root), { withFileTypes: true })) {
      if (item.isDirectory()) await visit(`${name}/${item.name}`);
      else if (item.name.endsWith('.mjs')) await add(`${name}/${item.name}`);
    }
  }
  await visit('src'); await add('index.mjs'); await add('tests/messaging/worker.mjs');
  return new Miniflare({ cf: false, telemetry: { enabled: false }, resourcePersistencePath: path, workers: [{ config: {
    type: 'worker', name: 'messaging-mail-test', compatibilityDate: '2026-09-01',
    manifest: { mainModule: 'tests/messaging/worker.mjs', modulesRoot: fileURLToPath(root), modules },
    env: { DB: { type: 'd1', id: 'messaging-mail-events' }, SOURCE: { type: 'text', value: JSON.stringify(source) }, NOW: { type: 'text', value: String(now) } },
  } }] });
}
export async function ingest(runtime, token, options = {}) {
  const response = await runtime.dispatchFetch('https://app.example.test/events', { method: 'POST', body: JSON.stringify({ token, options }) });
  return { status: response.status, ...(await response.json()) };
}
