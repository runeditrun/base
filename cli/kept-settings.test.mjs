import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { isolatedQueue } from './fixtures/queue.mjs';

const base = join(import.meta.dirname, '..');
const source = path => pathToFileURL(join(base, path)).href;

// An install made before its seed declared operator sign-in keeps its saved
// settings on an in-place upgrade, and setup adds the managed secrets the new
// manifest needs so its operators can still sign in.
test('setup on an earlier install adds missing managed secrets and keeps every saved value', { timeout: 60000 }, async t => {
 const env = await isolatedQueue(t);
 const root = await mkdtemp(join(tmpdir(), 'rer-kept-settings-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const pins = JSON.parse(await readFile(join(base, 'default-seed/package.json'), 'utf8'));
 await writeFile(join(root, '.node-version'), pins.engines.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: pins.engines, packageManager: pins.packageManager }));
 const socket = createServer();
 await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
 const port = socket.address().port;
 await new Promise(resolve => socket.close(resolve));
 const managed = name => ({ name, label: name, kind: 'secret', input: 'managed', required: true, ownerVisible: false, generate: 'hex' });
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Upgraded install', groups: [], fields: [
  { name: 'ADMIN_EMAIL', label: 'Owner email', kind: 'email', required: true },
  managed('SUBSCRIBER_SECRET'), managed('SESSION_SECRET'), managed('INSTALLATION_KEY'), managed('SETUP_TOKEN'),
  { name: 'CLAIM_TOKEN', label: 'Claim token', kind: 'secret', required: true, ownerVisible: true, generate: 'hex' },
 ], steps: [{ type: 'extension', id: 'native-owner' }] }));
 // The real installer lifecycle stops at the seed's start hook and records the
 // settings it would hand the application.
 await writeFile(join(root, 'adapter.mjs'), `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localInstaller } from ${JSON.stringify(source('onboarding/adapter.mjs'))};
import { commandAdapter as declare } from ${JSON.stringify(source('cli/adapter.mjs'))};
const lifecycle = localInstaller({ secrets: { keepExisting: true }, async start(context) {
 await writeFile(join(context.root, 'handoff.json'), JSON.stringify(Object.keys(context.vars)));
 throw Error('Evidence ends at the declared seed start hook');
} });
export const commandAdapter = declare(lifecycle, { setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'ADMIN_EMAIL' } } });
`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/upgraded-install', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { setup: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Local setup.' } } }));
 // The earlier install: an owner comment, the owner, and a subscriber secret
 // whose existing links must keep working. The owner already removed the claim token.
 const earlier = '# kept by the owner\nADMIN_EMAIL="owner@example.test"\nSUBSCRIBER_SECRET=test-synthetic-subscriber-links-secret';
 const path = join(root, '.dev.vars');
 await writeFile(path, earlier, { mode: 0o600 });
 const setup = () => {
  const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'setup', '--port', String(port), '--json', '--non-interactive'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, 'only the seed start hook stops setup: ' + result.stdout);
  return result;
 };
 const result = setup();
 const upgraded = await readFile(path, 'utf8');
 assert.ok(upgraded.startsWith(earlier + '\n'), 'saved bytes stay exactly as they were');
 const added = Object.fromEntries(upgraded.slice(earlier.length + 1).trim().split('\n').map(line => line.split('=')));
 assert.deepEqual(Object.keys(added).sort(), ['INSTALLATION_KEY', 'SESSION_SECRET', 'SETUP_TOKEN']);
 for (const value of Object.values(added)) {
  assert.match(value, /^[0-9a-f]{64}$/);
  assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value), 'a generated secret was printed');
 }
 assert.ok(JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8')).includes('INSTALLATION_KEY'), 'the application receives the added secret');
 assert.equal((await stat(path)).mode & 0o777, 0o600);
 setup();
 assert.equal(await readFile(path, 'utf8'), upgraded, 'a later setup keeps the upgraded settings exactly');
});
