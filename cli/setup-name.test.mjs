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

test('setup accepts declared owner names and nameless installers, refusing unsupported name flags', async t => {
 const env = await isolatedQueue(t);
 for (const nameField of [undefined, 'displayName', 'ADMIN_NAME']) {
  const root = await mkdtemp(join(tmpdir(), 'rer-setup-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pins=JSON.parse(await readFile(join(base,'default-seed/package.json'),'utf8'));
  await writeFile(join(root,'.node-version'),pins.engines.node+'\n');
  await writeFile(join(root,'package.json'),JSON.stringify({engines:pins.engines,packageManager:pins.packageManager}));
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const fields = [{ name: 'ADMIN_EMAIL', label: 'Owner email', kind: 'email', required: true }];
  if (nameField === 'ADMIN_NAME') fields.push({ name: nameField, label: 'Owner name', kind: 'text', required: true });
  await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Native owner', groups: [], fields, steps: [{ type: 'extension', id: 'native-owner' }] }));
  // Use the real installer lifecycle and stop at its seed-owned start hook.
  // No application is substituted: the receipt proves validated setup handoff.
  await writeFile(join(root, 'adapter.mjs'), `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localInstaller } from ${JSON.stringify(source('onboarding/adapter.mjs'))};
import { commandAdapter as declare } from ${JSON.stringify(source('cli/adapter.mjs'))};
const lifecycle = localInstaller({ secrets: { keepExisting: true }, async start(context) {
 await writeFile(join(context.root, 'handoff.json'), JSON.stringify(context.input));
 throw Error('Evidence ends at the declared seed start hook');
} });
export const commandAdapter = declare(lifecycle, { ownerBootstrap: ${nameField === 'displayName'}, setup: { manifestFile: 'rer-setup.json' }, input: { names: ${JSON.stringify({ email: 'ADMIN_EMAIL', ...(nameField === 'ADMIN_NAME' ? { name: nameField } : {}) })} } });
`);
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/native-owner', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { setup: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Local setup.' } } }));
  const run = args => {
   const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'setup', '--port', String(port), '--json', '--non-interactive', ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
   assert.ifError(result.error);
   return { ...result, events: result.stdout.trim().split('\n').map(JSON.parse) };
  };
  const fresh = run(['--owner-email', 'owner@example.test']);
  assert.equal(fresh.status, 1, 'fresh setup reaches the seed start hook: ' + fresh.stdout);
  assert.equal(JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8')).ADMIN_EMAIL, 'owner@example.test');
  const settings = 'ADMIN_EMAIL="owner@example.test"\nSESSION_SECRET="synthetic-retained-owner-settings"\n';
  await writeFile(join(root, '.dev.vars'), settings, { mode: 0o600 });
  for (const args of [[], ['--owner-email', 'owner@example.test']]) {
   const result = run(args);
   assert.equal(result.status, 1, 'only the seed start hook stops setup: ' + result.stdout);
   const input = JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8'));
   assert.equal(input.ADMIN_EMAIL, 'owner@example.test');
   if (nameField) assert.equal(input[nameField], 'Owner');
   else assert.ok(!Object.hasOwn(input, 'displayName'), 'nameless installer receives no undeclared name');
  }
  await rm(join(root, 'handoff.json'));
  const explicit = run(['--owner-name', 'Chosen Owner']);
  if (nameField) {
   assert.equal(explicit.status, 1);
   assert.equal(JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8'))[nameField], 'Chosen Owner');
  } else {
   assert.equal(explicit.status, 2);
   assert.ok(explicit.events.some(event => event.code === 'invalid_invocation' && /owner-name.*unsupported/.test(event.message)));
   await assert.rejects(readFile(join(root, 'handoff.json')), { code: 'ENOENT' });
  }
  assert.equal(run(['--owner-email', 'other@example.test']).status, 4, 'retained owner conflict is still refused');
  assert.equal(await readFile(join(root, '.dev.vars'), 'utf8'), settings, 'setup preserves retained private bytes');
 }
});
