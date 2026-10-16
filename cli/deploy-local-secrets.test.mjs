import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from './main.mjs';
import { runCommand } from './lifecycle.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';
import { workerOrigin } from '../modules/deploy-kit/worker.mjs';

const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
const localFile = path => /(?:^|\/)(?:\.dev\.vars|\.env)(?:\.[^/]*)?$/.test(path);

function restoreEnvironment(t) {
 const saved = { ...process.env };
 t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); });
}

// Public CLI door with the real owner kit; only Cloudflare's network edge is fake.
// The seed's build does what a Cloudflare Vite build without exclusion does: it
// copies the checkout's .dev.vars into the Worker and asset output, and copies
// whatever is in public/ into the assets.
test('rer deploy uploads no local settings file: its build never sees .dev.vars, and one planted in dist is refused by name', async t => {
 restoreEnvironment(t);
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-local-secrets-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const provider = ownerProvider();
 t.after(() => provider.close());
 Object.assign(process.env, { CI: 'true', CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token });
 const sentinel = randomBytes(24).toString('hex'), uploads = [];
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input), method = init.method ?? 'GET';
  if (method === 'POST' && url.pathname.endsWith('/assets-upload-session')) uploads.push(...Object.keys(JSON.parse(init.body).manifest).map(path => ({ kind: 'asset', path: path.slice(1) })));
  if (method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(url.pathname)) for (const [path] of init.body) if (path !== 'metadata') uploads.push({ kind: 'module', path });
  const bytes = init.body instanceof FormData ? await Promise.all([...init.body].map(async ([, value]) => typeof value === 'string' ? value : Buffer.from(await value.arrayBuffer()).toString())) : [String(init.body ?? '')];
  if (bytes.some(text => text.includes(sentinel))) uploads.push({ kind: 'value', path: url.pathname });
  return provider.fetch(input, init);
 });
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', r2: [{ binding: 'FILES' }] }));
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\n.wrangler/\n.dev.vars\npublic/\n');
 await writeFile(join(root, 'adapter.mjs'), `import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
 import { join } from 'node:path';
 import { ownerDeploy } from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const copied = async (from, to) => { try { await copyFile(from, to); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
 const lifecycle = { settings: ['.dev.vars'], hooks: {}, run: async root => {
  await mkdir(join(root, 'dist/server'), { recursive: true }); await mkdir(join(root, 'dist/client'), { recursive: true });
  await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
  await writeFile(join(root, 'dist/server/index.js'), 'export default {fetch(){}}');
  await writeFile(join(root, 'dist/client/index.html'), 'app');
  await copied(join(root, '.dev.vars'), join(root, 'dist/server/.dev.vars'));
  await copied(join(root, '.dev.vars'), join(root, 'dist/client/.dev.vars'));
  for (const name of await readdir(join(root, 'public')).catch(() => [])) await copied(join(root, 'public', name), join(root, 'dist/client', name));
 } };
 export const commandAdapter = { ...lifecycle, deploy: ownerDeploy('deploy.json', lifecycle) };`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy the fixture in the fake Cloudflare account.' } } }));
 git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
 const settings = `OWNER_EMAIL=owner@example.test\nAI_PROVIDER_API_KEY=${sentinel}\n`;
 await writeFile(join(root, '.dev.vars'), settings, { mode: 0o600 });
 const output = [];
 t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
 const run = () => main(['deploy', '--cwd', root, '--json']);

 assert.equal(await run(), 0, output.join(''));
 assert.ok(uploads.some(item => item.kind === 'module') && uploads.some(item => item.kind === 'asset'), 'the deploy uploaded its build');
 assert.deepEqual(uploads.filter(item => item.kind === 'value' || localFile(item.path)), [], 'no local settings file or value reached the provider');
 const built = (await readdir(join(root, 'dist'), { recursive: true })).filter(localFile);
 assert.deepEqual(built, [], 'the build output holds no local settings file');
 assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), settings, '.dev.vars is restored unchanged');

 // A file the build copies from public/ is planted in the output whatever rer hides.
 await mkdir(join(root, 'public'));
 await writeFile(join(root, 'public/.env'), 'PLANTED=throwaway\n');
 const writes = provider.state.writes.length, sent = uploads.length;
 output.length = 0;
 assert.equal(await run(), 4);
 assert.match(output.join(''), /dist\/client\/\.env/);
 assert.equal(provider.state.writes.length, writes, 'nothing was written to the provider');
 assert.equal(uploads.length, sent, 'nothing was uploaded');
});

// The lifecycle deploy door with a Lamp-shaped deploy hook: like `wrangler deploy`
// with a secrets file it keeps no state and uploads every secret value rer hands
// it. A subscriber link and a session are HMACs under the live secrets.
async function hookCheckout(t, provider, root) {
 const declaration = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', secrets: ['SESSION_SECRET', 'SUBSCRIBER_TOKEN_SECRET'].map(name => ({ binding: name, environment: name })) };
 const manifest = { steps: [], fields: declaration.secrets.map(({ binding }) => ({ name: binding, kind: 'secret', generate: 'hex' })) };
 const adapter = { settings: [], run: async () => {}, hooks: {} };
 adapter.deploy = async ({ options }) => {
  const api = cloudflare({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN }), worker = `fixture-${options.environment ?? 'production'}`;
  const body = new FormData();
  body.set('metadata', new Blob([JSON.stringify({ main_module: 'index.js', compatibility_date: declaration.compatibilityDate, bindings: [{ type: 'plain_text', name: 'RER_DEPLOY_SOURCE', text: git(root, 'rev-parse', 'HEAD') }], keep_bindings: ['secret_text'] })], { type: 'application/json' }));
  body.set('index.js', new Blob(['export default {fetch(){return new Response("ok")}}'], { type: 'application/javascript+module' }), 'index.js');
  await api.request(`/workers/scripts/${worker}`, { method: 'PUT', body });
  for (const { binding, environment } of declaration.secrets) await api.request(`/workers/scripts/${worker}/secrets`, { method: 'PUT', body: { name: binding, text: process.env[environment], type: 'secret_text' } });
  return { deployed: true, origin: await workerOrigin(api, worker, { enable: true }) };
 };
 await writeFile(join(root, 'deploy.json'), JSON.stringify(declaration));
 await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.gitignore'), '.rer/\n.wrangler/\ndeploy.env\n');
 await writeFile(join(root, 'deploy.env'), `CLOUDFLARE_ACCOUNT_ID=${provider.accountId}\nCLOUDFLARE_API_TOKEN=${provider.token}\n`, { mode: 0o600 });
 const progress = [];
 const run = (options = {}) => runCommand({ root, profile: 'first-party', adapter, setupManifest: manifest }, { verb: 'deploy', forwarded: [], envFile: 'deploy.env', json: true, ...options }, { progress: line => progress.push(line), event: () => {} });
 return { run, progress };
}

test('a redeploy reuses the secrets rer generated; a checkout without them refuses rather than rotating a live install', async t => {
 restoreEnvironment(t);
 process.env.CI = 'true';
 for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SESSION_SECRET', 'SUBSCRIBER_TOKEN_SECRET']) delete process.env[key];
 const provider = ownerProvider();
 t.after(() => provider.close());
 t.mock.method(globalThis, 'fetch', provider.fetch);
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-kept-secrets-')));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const first = join(directory, 'first');
 await mkdir(first);
 const deployed = await hookCheckout(t, provider, first);
 git(first, 'init', '-q'); git(first, 'add', '.'); git(first, 'commit', '-qm', 'fixture');
 const live = name => provider.state.secrets.find(item => item.name === name)?.value;
 const sign = (name, text) => createHmac('sha256', live(name)).update(text).digest('hex');

 await deployed.run();
 const link = sign('SUBSCRIBER_TOKEN_SECRET', 'unsubscribe:subscriber-1'), session = sign('SESSION_SECRET', 'session:operator-1');
 const file = join(first, '.rer/deploy/production.secrets.env');
 assert.equal((await stat(file)).mode & 0o777, 0o600);
 assert.equal(git(first, 'check-ignore', '.rer/deploy/production.secrets.env'), '.rer/deploy/production.secrets.env', 'Git ignores the kept secrets');
 assert.ok(deployed.progress.some(line => /generated SESSION_SECRET, SUBSCRIBER_TOKEN_SECRET .*production\.secrets\.env/.test(line)));

 await deployed.run();
 assert.equal(sign('SUBSCRIBER_TOKEN_SECRET', 'unsubscribe:subscriber-1'), link, 'an emailed unsubscribe link stays valid');
 assert.equal(sign('SESSION_SECRET', 'session:operator-1'), session, 'a signed-in session stays alive');
 assert.ok(deployed.progress.some(line => /reused SESSION_SECRET, SUBSCRIBER_TOKEN_SECRET/.test(line)));

 // A fresh checkout of the same commit has no kept secrets: rer refuses before any build or upload.
 const fresh = join(directory, 'fresh');
 git(directory, 'clone', '-q', first, fresh);
 await cp(join(first, 'deploy.env'), join(fresh, 'deploy.env'));
 const again = await hookCheckout(t, provider, fresh), writes = provider.state.writes.length;
 await assert.rejects(again.run(), error => error.code === 'safety_refusal' && /holds SESSION_SECRET, SUBSCRIBER_TOKEN_SECRET/.test(error.message) && /--rotate-secret SESSION_SECRET,SUBSCRIBER_TOKEN_SECRET/.test(error.message) && !error.message.includes(live('SESSION_SECRET')));
 assert.equal(provider.state.writes.length, writes, 'nothing was uploaded');
 await assert.rejects(access(join(fresh, '.rer/deploy/production.secrets.env')));
 assert.equal(sign('SUBSCRIBER_TOKEN_SECRET', 'unsubscribe:subscriber-1'), link);

 // Restoring the kept file deploys with the same values; --rotate-secret replaces one on purpose.
 await mkdir(join(fresh, '.rer/deploy'), { recursive: true, mode: 0o700 });
 await cp(file, join(fresh, '.rer/deploy/production.secrets.env'));
 await again.run();
 assert.equal(sign('SESSION_SECRET', 'session:operator-1'), session);
 await again.run({ rotateSecret: 'SESSION_SECRET' });
 assert.notEqual(sign('SESSION_SECRET', 'session:operator-1'), session, 'the rotated session secret is new');
 assert.equal(sign('SUBSCRIBER_TOKEN_SECRET', 'unsubscribe:subscriber-1'), link, 'only the named secret rotates');
 assert.match(await readFile(join(fresh, '.rer/deploy/production.secrets.env'), 'utf8'), new RegExp(`^SESSION_SECRET=${live('SESSION_SECRET')}$`, 'm'));
});
