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
test('packed Business setup creates the Business and its profile through owner routes, repeats as a read and protects the owner session', { timeout: 40_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-business-setup-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 const packed = join(directory, 'packed');
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), packed);
 const company = JSON.parse(await readFile(join(base, 'cli/business/setup-company.json'), 'utf8'));
 const session = crypto.randomUUID().replaceAll('-', ''), cookie = '__Host-rer_session=' + session;
 const sessionFile = join(directory, 'owner.session');
 await writeFile(sessionFile, cookie + '\n', { mode: 0o600 });
 const remote = await setupServer(t, cookie);
 const args = ['--origin', remote.origin, '--session-file', sessionFile];
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
 const badOrigin = await cli(['--origin', 'http://example.test', '--session-file', sessionFile, '--confirm-demo']);
 assert.equal(badOrigin.code, 1); assert.equal(JSON.parse(badOrigin.stderr).code, 'demo_origin_invalid');
 assert.equal(remote.requests.length, 0, 'refusals happen before any network effect');
 const first = await cli([...args, '--confirm-demo']);
 assert.equal(first.code, 0, first.stderr);
 const receipt = JSON.parse(first.stdout);
 assert.deepEqual(receipt, { business_id: 'demo-business', name: company.name, default_hosting: 'managed', created: true, profile: 'saved' });
 assert.equal(remote.businesses[0].default_hosting, 'managed', 'platform default');
 assert.deepEqual(remote.profile, company.profile, 'the setup file profile is saved');
 assert.deepEqual(remote.requests.map(row => `${row.method} ${row.path}`),
  ['GET /api/business', 'POST /api/business', 'PUT /api/business/demo-business/profile'], 'only the owner routes that create a Business and save its profile');
 const mutations = remote.requests.filter(row => row.method !== 'GET').length;
 const second = await cli([...args, '--confirm-demo', '--json']);
 assert.equal(second.code, 0, second.stderr);
 assert.deepEqual(JSON.parse(second.stdout), { ...receipt, created: false, profile: 'unchanged' }, 'a repeat reuses the same Business');
 assert.equal(remote.requests.filter(row => row.method !== 'GET').length, mutations, 'repeat performs no mutation');
 // A profile that drifted is saved again on the same Business; a Business made with other hosting is refused.
 remote.profile.timezone = 'UTC';
 const drifted = await cli([...args, '--confirm-demo']);
 assert.equal(drifted.code, 0, drifted.stderr);
 assert.equal(JSON.parse(drifted.stdout).profile, 'saved'); assert.equal(remote.profile.timezone, company.profile.timezone);
 assert.equal(remote.businesses.length, 1);
 const otherHosting = await cli([...args, '--confirm-demo', '--hosting', 'self_host']);
 assert.equal(otherHosting.code, 1); assert.equal(JSON.parse(otherHosting.stderr).code, 'existing_demo_hosting_differs');
 remote.refusal = { code: session, message: cookie };
 const reflected = await cli([...args, '--confirm-demo', '--json']);
 assert.equal(reflected.code, 1); assert.equal(JSON.parse(reflected.stderr).code, 'demo_session_in_response');
 delete remote.refusal;
 for (const launcher of [join(base, 'bin/rer.mjs'), join(base, 'default-seed/scripts/rer.mjs')]) {
  assert.equal((await cli(['--help'], launcher)).code, 0);
 }
});
