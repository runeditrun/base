import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { isolatedQueue } from './fixtures/queue.mjs';

const base = join(import.meta.dirname, '..');
const source = path => pathToFileURL(join(base, path)).href;
async function freePort() {
 const server = createServer();
 try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
 } finally { await new Promise(resolve => server.close(resolve)); }
}

test('setup, dev and doctor use declared native settings and preserve saved bytes', async t => {
 const env = await isolatedQueue(t);
 for (const declaration of ['manifest', 'adapter', 'default']) await t.test(declaration, { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rer-declared-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
 const pins=JSON.parse(await readFile(join(base,'default-seed/package.json'),'utf8'));
 await writeFile(join(root,'.node-version'),pins.engines.node+'\n');
 await writeFile(join(root,'package.json'),JSON.stringify({engines:pins.engines,packageManager:pins.packageManager}));
  const emailKey = declaration === 'default' ? 'OWNER_EMAIL' : 'ADMIN_EMAIL';
  const originKey = declaration === 'default' ? 'AUTH_ORIGIN' : 'LOCAL_URL';
  const format = declaration === 'manifest' ? 'json' : 'dotenv';
  const file = format === 'json' ? 'settings.json' : '.dev.vars';
  const email = 'saved-owner@example.test', port = await freePort(), origin = `http://127.0.0.1:${port}`;
  let alternatePort = await freePort();
  while (alternatePort === port) alternatePort = await freePort();
  const fields = [{ name: emailKey, label: 'Owner email', kind: 'email', required: true, ...(declaration === 'manifest' ? { prefill: 'account-email' } : {}) },
   { name: 'OWNER_NAME', label: 'Owner name', kind: 'text', required: true, default: 'Owner' },
   ...(declaration === 'adapter' ? [] : [{ name: 'SESSION_SECRET', label: 'Session secret', kind: 'secret', required: true, ownerVisible: false, input: 'managed', generate: 'hex' }])];
  if (declaration === 'manifest') fields.push({ name: 'SETUP_TOKEN', label: 'Setup token', kind: 'secret', required: true, ownerVisible: true, generate: 'hex' });
  await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Declared settings', groups: [], fields,
   steps: declaration === 'manifest' ? [{ type: 'owner-claim', mode: 'setup-token', emailField: emailKey, tokenField: 'SETUP_TOKEN' }] : [{ type: 'extension', id: 'native-owner' }] }));
  const secrets = { file, format, ...(declaration === 'default' ? {} : { originKey }) };
  const names = { name: 'OWNER_NAME', ...(declaration === 'adapter' ? { email: emailKey } : {}) };
  // Stop at the real seed start hook: this tests CLI preflight and lifecycle
  // handoff without substituting an application or launching a server.
  await writeFile(join(root, 'adapter.mjs'), `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localInstaller } from ${JSON.stringify(source('onboarding/adapter.mjs'))};
import { commandAdapter as declare } from ${JSON.stringify(source('cli/adapter.mjs'))};
async function checkpoint(context) {
 await writeFile(join(context.root, 'handoff.json'), JSON.stringify({ origin: context.origin, input: context.input, settingNames: Object.keys(context.vars) }));
 throw Error('Evidence ends at the declared seed start hook');
}
const lifecycle = localInstaller({ secrets: ${JSON.stringify(secrets)}, start: checkpoint, signIn: checkpoint });
export const commandAdapter = declare(lifecycle, { setup: { manifestFile: 'rer-setup.json' }, input: { names: ${JSON.stringify(names)} }, settings: [${JSON.stringify(file)}] });
`);
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/native-settings', runtime: { requirements: [] }, requiredEnvironment: [],
   seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['setup', 'dev', 'doctor'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Local declared-settings flow.' }])) }));
  const settings = { [originKey]: origin, [emailKey]: email, OWNER_NAME: 'Owner', ...(declaration === 'adapter' ? {} : {SESSION_SECRET: 'test-synthetic-retained-session'}), ...(declaration === 'manifest' ? { SETUP_TOKEN: 'synthetic-test-synthetic-retained-bootstrap' } : {}) };
  const encode = values => format === 'json' ? JSON.stringify(values, null, 2) + '\n' : '# Retained private settings\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  const bytes = encode(settings), path = join(root, file);
  await writeFile(path, bytes, { mode: 0o600 });
  const run = args => {
   const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), ...args, '--json', '--non-interactive'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
   assert.ifError(result.error);
   return { ...result, event: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
  };
  assert.equal(run(['setup', '--owner-email', 'other-owner@example.test']).status, 4, declaration + ' refuses owner conflict');
  // Setup on another port moves the saved origin; the declared start hook then stops the flow.
  const moved = await (async () => { await rm(join(root, 'handoff.json'), { force: true }); assert.equal(run(['setup', '--port', String(alternatePort)]).status, 1); return JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8')); })();
  assert.equal(moved.origin, `http://127.0.0.1:${alternatePort}`);
  assert.equal(JSON.parse(format === 'json' ? await readFile(path, 'utf8') : JSON.stringify({ [originKey]: /^LOCAL_URL=(.*)$|^AUTH_ORIGIN=(.*)$/m.exec(await readFile(path, 'utf8')).slice(1).find(Boolean) }))[originKey], moved.origin, declaration + ' saves the moved origin');
  await writeFile(path, bytes, { mode: 0o600 });
  const handoff = async args => {
   await rm(join(root, 'handoff.json'), { force: true });
   const result = run(args);
   assert.equal(result.status, 1, 'only the declared start hook stops the flow');
   return JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8'));
  };
  const setup = await handoff(['setup']);
  assert.equal(setup.origin, origin);
  assert.equal(setup.input[emailKey], email);
  const dev = await handoff(['dev']);
  assert.equal(dev.input[emailKey], email);
  assert.equal(dev.origin, origin);
  if (declaration !== 'default') {
   const override = await handoff(['dev', '--port', String(alternatePort)]);
   assert.equal(override.origin, `http://127.0.0.1:${alternatePort}`);
   assert.ok(!override.settingNames.includes('AUTH_ORIGIN') && !override.settingNames.includes('OWNER_EMAIL'), 'no default aliases introduced');
  }
  const diagnostic = run(['doctor']);
  // These settings-only fixtures have no Playwright dependency. Their private
  // settings are valid, while the browser prerequisite is now diagnosed too.
  assert.equal(diagnostic.status, 3);
  assert.equal(diagnostic.event.diagnostics.browser.ok, false);
  assert.equal(diagnostic.event.diagnostics.browser.fix, 'rer install');
  assert.deepEqual(diagnostic.event.diagnostics.missingInputs, []);
  assert.equal(await readFile(path, 'utf8'), bytes, 'all valid flows preserve private bytes');
  await writeFile(path, encode({ SESSION_SECRET: settings.SESSION_SECRET }), { mode: 0o600 });
  const missing = run(['doctor']);
  assert.equal(missing.status, 3);
  assert.deepEqual(new Set(missing.event.diagnostics.missingInputs), new Set([emailKey, originKey]), 'diagnostics name the declared inputs');
 });
});

// A seed may declare an optional provider dependency and still be set up
// provider-free. With nothing connected the native owner claim has already
// closed first setup, so setup must not need /auth/setup-complete: this app,
// like a native-auth copy without that route, answers it with 404.
test('setup without a connected optional dependency finishes without the completion route', { timeout: 90000 }, async t => {
 const env = await isolatedQueue(t);
 const root = await mkdtemp(join(tmpdir(), 'rer-declared-dependency-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const pins = JSON.parse(await readFile(join(base, 'default-seed/package.json'), 'utf8'));
 await writeFile(join(root, '.node-version'), pins.engines.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: pins.engines, packageManager: pins.packageManager }));
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Declared dependency', groups: [], steps: [{ type: 'extension', id: 'native-owner' }],
  fields: [{ name: 'OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true },
   { name: 'SESSION_SECRET', label: 'Session secret', kind: 'secret', required: true, ownerVisible: false, input: 'managed', generate: 'hex' },
   { name: 'IDENTITY_PROVIDER', label: 'Identity provider', kind: 'url', required: false }],
  dependencies: [{ interface: 'oidc-provider@1', optional: true, cardinality: 1, address: 'IDENTITY_PROVIDER', paths: ['/auth/oidc/auth/callback', '/auth/oidc/auth/logout'] }] }));
 await writeFile(join(root, 'app.mjs'), `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
createServer((request, response) => {
 if (request.url === '/health') return response.end(JSON.stringify({ status: 'ok' }));
 if (request.url === '/auth/setup-complete') appendFileSync('completion-requests', 'x');
 response.writeHead(404).end();
}).listen(Number(process.argv[2]), '127.0.0.1');
`);
 await writeFile(join(root, 'adapter.mjs'), `
import { localInstaller } from ${JSON.stringify(pathToFileURL(join(base, 'onboarding/adapter.mjs')).href)};
import { commandAdapter as declare } from ${JSON.stringify(pathToFileURL(join(base, 'cli/adapter.mjs')).href)};
const lifecycle = localInstaller({ secrets: { file: '.dev.vars', format: 'dotenv', originKey: 'AUTH_ORIGIN' },
 start: context => ['node', ['app.mjs', String(context.runtimePort ?? new URL(context.origin).port)]],
 signIn: async () => {} });
export const commandAdapter = declare(lifecycle, { setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'OWNER_EMAIL' } }, settings: ['.dev.vars'] });
`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/declared-dependency', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: Object.fromEntries(['setup', 'dev', 'doctor'].map(verb => [verb, { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Local declared-dependency flow.' }])) }));
 const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'setup', '--owner-email', 'owner@example.test', '--port', String(await freePort()), '--json', '--non-interactive'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
 assert.ifError(result.error);
 assert.equal(result.status, 0, result.stdout + result.stderr);
 await assert.rejects(readFile(join(root, 'completion-requests')), 'nothing was connected, so setup asks the app to complete nothing');
});
