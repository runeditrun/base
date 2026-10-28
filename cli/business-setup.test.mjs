import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { setupServer } from './fixtures/business/setup-server.mjs';

const base = resolve(import.meta.dirname, '..');
test('packed Business setup provisions through owner routes, repeats as a read and protects the owner session', { timeout: 40_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-business-setup-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const packed = join(directory, 'packed');
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 const session = crypto.randomUUID(), cookie = '__Host-rer_session=' + session;
 const sessionFile = join(directory, 'owner.session');
 await writeFile(sessionFile, cookie + '\n', { mode: 0o600 });
 const remote = await setupServer(t, cookie);
 const args = ['--origin', remote.origin, '--session-file', sessionFile, '--wait-seconds', '0'];
 async function cli(extra, launcher = join(packed, 'global/rer.mjs')) {
  const result = await new Promise((resolveRun, reject) => {
   const argv = [launcher, 'business', 'setup', ...extra];
   assert.ok(!argv.some(arg => arg.includes(session)), 'session never enters argv');
   const child = spawn(process.execPath, argv, { cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, RER_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
   t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
   let stdout = '', stderr = '';
   child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
   child.once('error', reject); child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
  assert.ok(!(result.stdout + result.stderr).includes(session), 'session absent from every output and receipt');
  assert.ifError(remote.error);
  return result;
 }
 const refused = await cli(args);
 assert.equal(refused.code, 1); assert.equal(JSON.parse(refused.stderr).code, 'demo_confirmation_and_session_file_required');
 await chmod(sessionFile, 0o644);
 const publicFile = await cli([...args, '--confirm-demo', '--json']);
 assert.equal(publicFile.code, 1); assert.equal(JSON.parse(publicFile.stderr).code, 'demo_session_file_must_be_private');
 await chmod(sessionFile, 0o600);
 const wrongHosting = await cli([...args, '--confirm-demo', '--hosting', 'hosted']);
 assert.equal(wrongHosting.code, 1); assert.equal(JSON.parse(wrongHosting.stderr).code, 'demo_arguments_invalid');
 assert.equal(remote.requests.length, 0, 'refusals happen before any network effect');
 const first = await cli([...args, '--confirm-demo']);
 assert.equal(first.code, 0, first.stderr);
 const receipt = JSON.parse(first.stdout);
 assert.equal(receipt.complete, true);
 assert.equal(receipt.required_provisioned, remote.seeds.length);
 assert.ok(receipt.seeds.every(row => row.state === 'already provisioned' && row.pause_refused && row.attributed));
 assert.equal(remote.businesses[0].default_hosting, 'managed', 'platform default');
 assert.ok(remote.profile.display_name && remote.profile.country && remote.profile.timezone);
 const root = '/api/business/demo-business';
 assert.equal(remote.requests.filter(row => row.path === root + '/settings/deliver').length, remote.seeds.length);
 assert.ok(remote.requests.filter(row => row.path === root + '/settings/deliver').every(row => JSON.stringify(row.body) === '{}'));
 assert.equal(remote.requests.filter(row => row.path === root + '/agents/seed-token').length, remote.seeds.length);
 assert.ok(remote.requests.some(row => row.path.endsWith('/confirm')));
 const mutations = remote.requests.filter(row => row.method !== 'GET').length;
 const second = await cli([...args, '--confirm-demo', '--json']);
 assert.equal(second.code, 0, second.stderr);
 const repeat = JSON.parse(second.stdout);
 assert.deepEqual(repeat, receipt, 'successful repeats return the same complete receipts');
 assert.equal(repeat.business_id, receipt.business_id); assert.equal(repeat.policy_id, receipt.policy_id);
 for (const row of repeat.seeds) {
  const previous = receipt.seeds.find(seed => seed.app === row.app);
  assert.equal(row.state, 'already provisioned');
  for (const id of ['token_id', 'consent_id', 'policy_id']) assert.equal(row[id], previous[id]);
 }
 assert.equal(remote.requests.filter(row => row.method !== 'GET').length, mutations, 'repeat performs no mutation');
 // Missing required adoptions remain visible and nonzero on the real command.
 remote.seeds.push({ app: 'extra-required', required: true, state: 'not yet on the agent door' });
 remote.seeds[0].required = false;
 const incomplete = await cli([...args, '--confirm-demo', '--json']);
 assert.equal(incomplete.code, 1);
 assert.equal(JSON.parse(incomplete.stdout).complete, false);
 assert.ok(JSON.parse(incomplete.stdout).seeds.some(row => row.app === 'extra-required' && row.state === 'not yet on the agent door'));
 remote.refusal = { code: session, message: cookie };
 const reflected = await cli([...args, '--confirm-demo', '--json']);
 assert.equal(reflected.code, 1); assert.equal(JSON.parse(reflected.stderr).code, 'demo_session_in_response');
 delete remote.refusal;
 for (const launcher of [join(base, 'bin/rer.mjs'), join(base, 'default-seed/scripts/rer.mjs')]) {
  assert.equal((await cli(['--help'], launcher)).code, 0);
 }
});
