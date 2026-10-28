import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from '../../container/adapters/d1-workerd.mjs';

export const DEV_KEY = 'only-a-public-ai-test-key-not-a-real-checkout-key-0000000000';
const root = new URL('../../../', import.meta.url);
export async function runtime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rer-ai-'));
  const modules = {};
  async function add(name) { modules[name] = { type: 'esm', contents: await readFile(new URL(name, root), 'utf8') }; }
  async function walk(path) {
    for (const item of await readdir(new URL(path, root), { withFileTypes: true })) {
      if (item.name === 'tests' || item.name === 'node_modules') continue;
      if (item.isDirectory()) await walk(`${path}/${item.name}`);
      else if (item.name.endsWith('.mjs')) await add(`${path}/${item.name}`);
    }
  }
  await walk('modules/ai'); await walk('modules/operator-auth'); await add('modules/ai/tests/worker.mjs');
  let mf;
  async function start() {
    mf = new Miniflare({ cf: false, telemetry: { enabled: false }, resourcePersistencePath: join(directory, 'state'), workers: [{ config: {
      type: 'worker', name: 'ai-test', compatibilityDate: '2026-09-01',
      manifest: { mainModule: 'modules/ai/tests/worker.mjs', modulesRoot: fileURLToPath(root), modules },
      env: { DB: { type: 'd1', id: 'ai-outbox' }, AUTH_LOCAL: { type: 'text', value: 'true' }, AUTH_ORIGIN: { type: 'text', value: 'http://127.0.0.1:8787' }, RER_DEV_KEY: { type: 'text', value: DEV_KEY } },
    } }] });
    await mf.ready;
  }
  t.after(async () => { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return { get url() { return mf.ready; }, get db() { return mf.getD1Database('DB', 'ai-test'); }, async restart() { await mf.dispose(); await start(); }, async call(path, { key = DEV_KEY, cookie, body, headers = {} } = {}) {
    return fetch(new URL(path, await mf.ready), { method: body === undefined ? 'GET' : 'POST', headers: { ...(key ? { 'x-rer-dev-key': key } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  } };
}
