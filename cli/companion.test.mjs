import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';
import { managementServer } from './fixtures/companion/server.mjs';

// `rer companion` runs from the packed package, as `npx -y @runeditrun/rer`
// runs it. Fakes stand only at the management service's HTTP edge and in
// place of the provider CLIs; Git and the macOS sandbox are real.
const base = resolve(import.meta.dirname, '..'), fixtures = join(import.meta.dirname, 'fixtures/companion');
const macOS = process.platform === 'darwin';
// Public repositories stand in for the app's identity; nothing is fetched from them.
const repository = 'runeditrun/base', projectId = 'app-1', origin = `https://github.com/${repository}.git`;
const codexToken = 'synthetic-fixture-codex-access-token-0001';
let directory, launcher, providers;
before(async () => {
 directory = await realpath(await mkdtemp(join(tmpdir(), 'rer-companion-')));
 const bytes = await readFile(await buildPackage(base, join(directory, 'package')));
 await writePackage(readPackage(bytes, { integrity: integrity(bytes) }), join(directory, 'packed'));
 launcher = join(directory, 'packed/global/rer.mjs');
 providers = join(directory, 'providers');
 await mkdir(providers);
 for (const name of ['codex', 'claude']) await symlink(join(fixtures, `${name}.mjs`), join(providers, name));
});
after(() => directory && rm(directory, { recursive: true, force: true }));

function start(args, { home, state, env = {} }) {
 const child = spawn(process.execPath, [launcher, 'companion', ...args], {
  cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: `${providers}:${process.env.PATH}`, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', RER_NO_UPDATE_CHECK: '1', RER_LOCAL_HOME: state, ...env },
 });
 let stdout = '', stderr = '';
 child.stdout.on('data', chunk => { stdout += chunk; });
 child.stderr.on('data', chunk => { stderr += chunk; });
 const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
 const done = new Promise((resolveRun, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
 });
 return { child, done };
}
const companion = (args, options) => start(args, options).done;
const readState = async state => JSON.parse(await readFile(join(state, 'state.json'), 'utf8'));
const mode = async path => (await stat(path)).mode & 0o777;

function ownerGit(cwd, ...args) {
 return execFileSync('git', ['-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
async function ownerCheckout(path, remote = origin) {
 await mkdir(path, { recursive: true });
 ownerGit(path, 'init', '-q', '-b', 'main');
 ownerGit(path, 'remote', 'add', 'origin', remote);
 await writeFile(join(path, 'file.txt'), 'committed\n');
 ownerGit(path, 'add', '.'); ownerGit(path, 'commit', '-q', '-m', 'first');
 return ownerGit(path, 'rev-parse', 'HEAD');
}
async function paired(t, root, provider = 'codex') {
 const home = join(root, 'home'), state = join(root, 'state'), app = join(root, 'app');
 await mkdir(home, { recursive: true });
 const first = await ownerCheckout(app), server = await managementServer(t, { repository, projectId });
 assert.equal((await companion(['map', projectId, repository, app], { home, state })).code, 0);
 assert.equal((await companion(['pair', server.origin, server.code, '--provider', provider], { home, state })).code, 0);
 return { home, state, app, first, server };
}
const until = async (check, what) => {
 for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 50))) if (Date.now() - started > 30000) throw new Error(`Timed out waiting for ${what}`);
};

test('pair takes the pairing screen URL and code, keeps the device key private and checks the repository', async t => {
 const root = join(directory, 'pair'), home = join(root, 'home'), state = join(root, 'state'), app = join(root, 'app');
 await mkdir(home, { recursive: true });
 await ownerCheckout(app);
 const server = await managementServer(t, { repository, projectId });
 const code = server.code;

 assert.equal((await companion(['pair', server.origin, code], { home, state })).code, 1, 'pairing needs a locally approved checkout first');
 assert.equal((await companion(['pair', server.origin, code, '--project', projectId], { home, state })).code, 1, 'a named project needs its checkout approved first');
 assert.equal((await companion(['map', projectId, 'just-every/run-inkwell', app], { home, state })).code, 1, 'a checkout whose origin is another repository is refused');
 assert.equal((await companion(['map', projectId, repository, app], { home, state })).code, 0);
 assert.equal((await companion(['pair', 'http://example.test', code], { home, state })).code, 1, 'plain HTTP is refused off loopback');
 assert.equal(server.posted('/api/local/pair').length, 0, 'nothing was sent before the refusals');

 const result = await companion(['pair', server.origin, code], { home, state });
 assert.equal(result.code, 0, result.stderr);
 assert.deepEqual(server.posted('/api/local/pair').map(request => request.body), [{ code, name: 'Local engineering computer', provider: 'codex', project_id: projectId }]);
 const saved = await readState(state);
 assert.equal(saved.token, server.token);
 assert.equal(await mode(join(state, 'state.json')), 0o600);
 assert.equal(await mode(state), 0o700);
 const status = await companion(['status'], { home, state });
 assert.equal(status.code, 0);
 assert.equal(JSON.parse(status.stdout).device.id, 'device-1');
 assert.deepEqual(JSON.parse(status.stdout).projects, [projectId]);
 for (const output of [result.stdout, result.stderr, status.stdout, status.stderr]) assert.ok(!output.includes(server.token), 'the device key is never printed');

 // The earlier positional form still pairs, with its provider and name.
 const legacy = join(root, 'legacy-state');
 server.code = 'EFGH-2345';
 assert.equal((await companion(['map', projectId, repository, app], { home, state: legacy })).code, 0);
 assert.equal((await companion(['pair', server.origin, server.code, projectId, 'claude', 'Studio computer'], { home, state: legacy })).code, 0);
 assert.deepEqual(server.posted('/api/local/pair').at(-1).body, { code: 'EFGH-2345', name: 'Studio computer', provider: 'claude', project_id: projectId });

 // A code that pairs another app's repository leaves this computer unpaired.
 const other = join(root, 'other'), otherState = join(root, 'other-state');
 await ownerCheckout(other, 'https://github.com/just-every/run-inkwell.git');
 server.code = 'JKLM-2345';
 assert.equal((await companion(['map', projectId, 'just-every/run-inkwell', other], { home, state: otherState })).code, 0);
 assert.equal((await companion(['pair', server.origin, server.code], { home, state: otherState })).code, 1);
 assert.equal((await readState(otherState)).token, undefined);

 if (!macOS) {
  // Without the macOS boundary, run refuses before it asks the app for work.
  const before = server.requests.length;
  assert.equal((await companion(['run', '--once'], { home, state })).code, 1);
  assert.equal(server.requests.length, before);
 }
});

test('run turns a job into an exact-commit isolated checkout inside the OS boundary and relays it durably', { skip: !macOS && 'run needs macOS sandbox-exec' }, async t => {
 const root = join(directory, 'run');
 const { home, state, app, first, server } = await paired(t, root);
 const canary = join(root, 'canary.txt'), outside = join(root, 'outside.txt'), marker = join(root, 'hook-ran'), template = join(root, 'template');
 await writeFile(canary, 'outside the workspace');
 await symlink(canary, join(app, 'canary-link'));
 await writeFile(join(app, '.gitattributes'), '*.txt filter=host-canary\n');
 ownerGit(app, 'add', '.'); ownerGit(app, 'commit', '-q', '-m', 'job base');
 const jobBase = ownerGit(app, 'rev-parse', 'HEAD');
 await writeFile(join(app, 'file.txt'), 'second\n');
 ownerGit(app, 'commit', '-q', '-am', 'owner moved on');
 await writeFile(join(app, 'file.txt'), 'owner dirty\n');
 await writeFile(join(app, 'owner-only'), 'untracked owner content');
 const owner = { head: ownerGit(app, 'rev-parse', 'HEAD'), branch: ownerGit(app, 'symbolic-ref', 'HEAD'), status: ownerGit(app, 'status', '--porcelain') };
 assert.notEqual(jobBase, first);

 // The host carries Git hooks, templates and filters, credentials and a Codex
 // configuration; none of them may reach preparation or the provider.
 await mkdir(join(template, 'hooks'), { recursive: true });
 await writeFile(join(template, 'hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`);
 await chmod(join(template, 'hooks/post-checkout'), 0o755);
 await writeFile(join(home, '.gitconfig'), `[filter "host-canary"]\n smudge = "touch '${marker}'; cat"\n required = true\n[init]\n templateDir = ${template}\n[core]\n hooksPath = ${join(template, 'hooks')}\n`);
 await mkdir(join(home, '.codex'));
 await writeFile(join(home, '.codex/auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: codexToken } }));
 await writeFile(join(home, '.codex/config.toml'), '[mcp_servers.host]\ncommand = "host-mcp"\n');
 const env = { GITHUB_TOKEN: 'synthetic-fixture-github-token', CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-token', GIT_TEMPLATE_DIR: template, GIT_DIR: join(root, 'wrong-git-dir'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(template, 'hooks') };

 assert.equal((await companion(['codex-auth'], { home, state, env })).code, 0);
 assert.equal(existsSync(join(state, 'executor-home/.codex/config.toml')), false, 'only auth.json is copied');
 assert.equal(await mode(join(state, 'executor-home/.codex/auth.json')), 0o600);
 // Verify is repository code: it sees the change but not the provider's credentials.
 const verify = [process.execPath, '-e', `const fs=require('fs');let leaked=true;try{fs.readFileSync(${JSON.stringify(join(state, 'executor-home/.codex/auth.json'))})}catch{leaked=false}process.exit(!leaked&&fs.readFileSync('change.txt','utf8')==='changed by provider\\n'?0:1)`];
 await writeFile(join(root, 'commands.json'), JSON.stringify({ verify: [verify] }));
 assert.equal((await companion(['commands', projectId, join(root, 'commands.json')], { home, state })).code, 0);

 server.queue('job-1', { baseCommit: jobBase, instructions: `Change the file. FIXTURE ${JSON.stringify({ canary, outside })}` });
 server.failResults = 1;
 const run = start(['run'], { home, state, env });
 server.onRequest = request => {
  // A remote response tries to approve escalation, then declines it.
  if (request.body.kind === 'approval' && !server.controls.length) server.controls.push(
   { job_id: 'job-1', sequence: 1, kind: 'respond', payload: { request: 'approval-1', response: { decision: 'accept' } } },
   { job_id: 'job-1', sequence: 2, kind: 'respond', payload: { request: 'approval-1', response: { decision: 'decline' } } });
  // The first result is lost with the process that sent it.
  if (request.path.endsWith('/result')) run.child.kill('SIGKILL');
 };
 const killed = await run.done;
 assert.equal(killed.signal, 'SIGKILL', killed.stderr);
 server.onRequest = () => {};
 const pending = (await readState(state)).outbox.map(item => item.path);
 assert.ok(pending.includes('/api/local/jobs/job-1/result'), 'the unsent result is kept on disk');

 assert.equal((await companion(['run', '--once'], { home, state })).code, 1, 'a runner lock left by a killed runner refuses a second runner');
 await rm(join(state, 'runner.lock'));
 // A redirect is refused, never followed: nothing reaches the other origin and the result stays queued.
 const other = await managementServer(t, { repository, projectId });
 server.redirect = other.origin;
 assert.equal((await companion(['run', '--once'], { home, state })).code, 1);
 assert.equal(other.requests.length, 0, 'nothing was sent to the redirect target');
 assert.ok((await readState(state)).outbox.some(item => item.path === '/api/local/jobs/job-1/result'), 'the redirected result is still queued');
 server.redirect = null;
 const attempts = server.posted('/result').length;
 const resumed = await companion(['run', '--once'], { home, state });
 assert.equal(resumed.code, 0, resumed.stderr);
 const results = server.posted('/result');
 assert.equal(results.length, attempts + 1, 'one more send delivers the queued result');
 for (const retry of results.slice(1)) assert.deepEqual(retry.body, results[0].body, 'the retried result keeps its event id and content');
 assert.equal((await readState(state)).outbox.length, 0);

 const { result } = results.at(-1).body;
 assert.equal(result.base_commit, jobBase);
 assert.equal(result.commit, jobBase, 'the checkout is the exact job commit, not the owner HEAD');
 const file = path => Buffer.from(result.files.find(entry => entry.path === path).contentBase64, 'base64').toString();
 assert.equal(file('change.txt'), 'changed by provider\n');
 const seen = JSON.parse(file('observed.json'));
 assert.ok(seen.args.includes('app-server') && seen.args.includes('features.apps=false'));
 assert.equal(seen.thread.sandbox, 'danger-full-access');
 assert.equal(seen.turn.sandboxPolicy.type, 'externalSandbox', 'the outer OS boundary, not Codex workspace-write, confines the turn');
 assert.deepEqual(seen.approval, { decision: 'decline' }, 'only the decline reached the provider');
 assert.equal(seen.workspaceWrite, 'allowed');
 for (const name of ['outsideRead', 'outsideWrite', 'symlinkRead']) assert.notEqual(seen[name], 'allowed', `${name} is denied`);
 assert.equal(seen.outsideExists, false);
 assert.equal(existsSync(outside), false);
 for (const name of ['GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'GIT_DIR', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_COUNT']) assert.ok(!seen.env.includes(name), `${name} stays out of the executor`);
 assert.ok(result.verification.some(entry => entry.command === verify.join(' ') && entry.exit_code === 0), 'the locally approved verify command ran');

 const events = server.posted('/events');
 assert.ok(events.every(request => request.body.run_id === 'run-job-1' && request.body.grant_id === 'grant-job-1'));
 assert.ok(events.some(request => request.body.kind === 'status' && request.body.payload.status === 'needs_input'), 'the refused remote approval is reported');
 assert.ok(events.some(request => request.body.payload?.method === 'item/completed'));
 assert.ok(!JSON.stringify(server.requests).includes(codexToken), 'provider credentials are redacted from relayed progress');

 assert.equal(existsSync(marker), false, 'no host hook, template or filter ran');
 assert.equal(existsSync(join(state, 'worktrees/job-1/.git/hooks/post-checkout')), false);
 assert.deepEqual({ head: ownerGit(app, 'rev-parse', 'HEAD'), branch: ownerGit(app, 'symbolic-ref', 'HEAD'), status: ownerGit(app, 'status', '--porcelain') }, owner);
 assert.equal(await readFile(join(app, 'file.txt'), 'utf8'), 'owner dirty\n');
 assert.equal(await readFile(join(app, 'owner-only'), 'utf8'), 'untracked owner content');
});

test('an uncertain running job is never restarted on its own, and a revoked device stops the runner', { skip: !macOS && 'run needs macOS sandbox-exec' }, async t => {
 const { home, state, server } = await paired(t, join(directory, 'uncertain'), 'claude');
 const head = (await readState(state)).mappings[projectId].checkout;
 server.queue('job-2', { baseCommit: ownerGit(head, 'rev-parse', 'HEAD'), instructions: 'Keep working.', provider: 'claude' });
 const run = start(['run'], { home, state });
 server.onRequest = request => { if (request.body.kind === 'session') run.child.kill('SIGKILL'); };
 await run.done;
 server.onRequest = () => {};
 const spawns = join(state, 'executor-home/spawns'), pid = Number((await readFile(spawns, 'utf8')).trim());
 await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the provider to stop with its runner');

 const argv = JSON.parse(await readFile(join(state, 'executor-home/claude-argv.json'), 'utf8'));
 assert.ok(argv.includes('--strict-mcp-config'));
 assert.equal(argv[argv.indexOf('--mcp-config') + 1], JSON.stringify({ mcpServers: {} }), 'no MCP server reaches the provider');
 const interrupted = await readState(state);
 assert.equal(interrupted.active.status, 'running');
 assert.equal(interrupted.active.identity.thread_id, 'claude-session-1');

 await rm(join(state, 'runner.lock'));
 const claims = server.posted('/claim').length;
 server.controls.push({ job_id: 'job-2', sequence: 1, kind: 'resume', payload: {} });
 const restarted = await companion(['run', '--once'], { home, state });
 assert.equal(restarted.code, 0, restarted.stderr);
 assert.equal((await readFile(spawns, 'utf8')).trim().split('\n').length, 1, 'the provider was not started again');
 assert.equal(server.posted('/claim').length, claims, 'no new job was claimed over the uncertain one');
 assert.equal(server.posted('/events').at(-1).body.payload.status, 'needs_input', 'a resume without a live executor asks the owner to reconcile');
 assert.equal((await readState(state)).active.status, 'running');

 server.token = 'synthetic-fixture-device-key-revoked';
 const revoked = await companion(['run'], { home, state });
 assert.equal(revoked.code, 1, 'a revoked device ends the runner');
});

test('no-turn attestation is explicit, exact and holds the runner lock', { skip: !macOS && 'attestation reads the checkout with Git inside macOS sandbox-exec' }, async () => {
 const root = join(directory, 'attest'), home = join(root, 'home'), state = join(root, 'state');
 const jobId = 'failed-setup', worktree = join(state, 'worktrees', jobId);
 await mkdir(home, { recursive: true });
 await mkdir(worktree, { recursive: true });
 ownerGit(worktree, 'init', '-q');
 ownerGit(worktree, 'remote', 'add', 'origin', origin);
 await writeFile(join(worktree, '.gitignore'), 'node_modules/\nignored-source/\n');
 await writeFile(join(worktree, 'source'), 'original');
 ownerGit(worktree, 'add', '.'); ownerGit(worktree, 'commit', '-q', '-m', 'base');
 const baseCommit = ownerGit(worktree, 'rev-parse', 'HEAD');
 // Even a clean, approved legacy checkout must not be accepted through a symlink.
 const ordinary = join(root, 'ordinary-worktree');
 await rename(worktree, ordinary);
 await symlink(ordinary, worktree);
 await writeFile(join(state, 'state.json'), JSON.stringify({
  mappings: { [projectId]: { repository, checkout: ordinary, remote: origin } }, outbox: [],
  active: { job: { id: jobId, repository, project_id: projectId, base_commit: baseCommit }, status: 'needs_reconciliation' },
 }), { mode: 0o600 });
 assert.equal((await companion(['confirm-unstarted', jobId, '--confirm-no-executor-started'], { home, state })).code, 1, 'legacy attestation refuses a symlinked worktree');
 await rm(worktree);
 await rename(ordinary, worktree);
 await mkdir(join(worktree, 'node_modules'));
 await writeFile(join(worktree, 'node_modules/dependency'), 'retained');
 // Setup ran repository code that planted a Git clean filter in the retained
 // checkout. Attestation must run it, if at all, only inside the boundary.
 const outsideMarker = join(root, 'filter-ran-outside');
 ownerGit(worktree, 'config', 'filter.planted.clean', `sh -c 'touch "${outsideMarker}"; touch "$HOME/filter-ran"; cat'`);
 await mkdir(join(worktree, '.git/info'), { recursive: true });
 await writeFile(join(worktree, '.git/info/attributes'), '* filter=planted\n');
 const active = { job: { id: jobId, run_id: 'run', repository, project_id: projectId, base_commit: baseCommit }, status: 'needs_reconciliation', phase: 'executor_starting', executorStarted: true, workspace: { worktree, baseCommit } };
 const saved = JSON.stringify({ mappings: { [projectId]: { repository, checkout: worktree, remote: origin } }, outbox: [], cursor: 2, provider: 'codex', active });
 await writeFile(join(state, 'state.json'), saved, { mode: 0o600 });
 const attest = (...flags) => companion(['confirm-no-turn-started', jobId, ...flags], { home, state });
 const refused = async (why, ...flags) => {
  assert.equal((await attest(...flags)).code, 1, why);
  assert.equal(await readFile(join(state, 'state.json'), 'utf8'), saved, `${why}: state unchanged`);
 };

 await refused('the confirmation flag is required');
 const flag = '--confirm-no-provider-turn-started';
 await writeFile(join(worktree, 'source'), 'edited');
 await refused('changed source', flag);
 await writeFile(join(worktree, 'source'), 'original');
 await mkdir(join(worktree, 'ignored-source'));
 await writeFile(join(worktree, 'ignored-source/custom.js'), 'keep');
 await refused('ignored files outside node_modules', flag);
 await rm(join(worktree, 'ignored-source'), { recursive: true });
 const provider = join(state, 'executor-home/.codex');
 await mkdir(join(provider, 'sessions'), { recursive: true });
 await writeFile(join(provider, 'sessions/turn.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: worktree } }));
 await refused('a recorded provider session for this worktree', flag);
 await writeFile(join(provider, 'sessions/turn.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: join(root, 'other-job') } }));
 const database = new DatabaseSync(join(provider, 'state_5.sqlite'));
 database.exec('CREATE TABLE threads(id TEXT, cwd TEXT)');
 database.prepare('INSERT INTO threads VALUES(?, ?)').run('known', worktree);
 await refused('a recorded provider thread for this worktree', flag);
 database.exec('DELETE FROM threads');
 database.prepare('INSERT INTO threads VALUES(?, ?)').run('unrelated', join(root, 'other-job'));
 database.close();
 await writeFile(join(state, 'runner.lock'), 'live-runner');
 await refused('a live runner holds the lock', flag);
 assert.equal(await readFile(join(state, 'runner.lock'), 'utf8'), 'live-runner');
 await rm(join(state, 'runner.lock'));
 assert.equal(existsSync(outsideMarker), false, 'the planted filter never ran outside the boundary');
 // Setup can also break the boundary's scratch folder; attestation then fails closed.
 const scratch = join(state, 'command-home/tmp');
 await rm(scratch, { recursive: true, force: true });
 await writeFile(scratch, '');
 await refused('the checkout cannot be read inside the boundary', flag);
 await rm(scratch);

 assert.equal((await attest(flag)).code, 0);
 const accepted = await readState(state);
 assert.equal(accepted.active.phase, 'pre_executor_failed');
 assert.equal(accepted.active.executorStarted, false);
 assert.deepEqual(accepted.active.recoveryAttestation.previousState, active);
 assert.equal(accepted.cursor, 2);
 assert.equal(await readFile(join(worktree, 'node_modules/dependency'), 'utf8'), 'retained');
 assert.equal(existsSync(join(state, 'runner.lock')), false);
 assert.ok(existsSync(join(state, 'command-home/filter-ran')), 'the planted filter ran inside the boundary');
 assert.equal(existsSync(outsideMarker), false, 'nor while the attestation was accepted');
});

test('claude-auth reports success only when the provider confirms a login in the dedicated executor home', async () => {
 const root = join(directory, 'claude-auth'), home = join(root, 'home'), state = join(root, 'state'), bin = join(root, 'bin');
 await mkdir(join(home, '.claude'), { recursive: true }); await mkdir(bin, { recursive: true });
 await writeFile(join(home, '.claude/settings.json'), '{"host":"configuration"}');
 // The provider CLI is the paid edge: `claude auth login` and `claude auth status --json`.
 const provider = (login, loggedIn) => `#!${process.execPath}
const { appendFileSync, existsSync, readdirSync, writeFileSync } = require('node:fs');
const [group, verb, ...rest] = process.argv.slice(2), home = process.env.HOME, log = ${JSON.stringify(join(root, 'calls.jsonl'))};
appendFileSync(log, JSON.stringify({ group, verb, rest, home, hostConfiguration: existsSync(home + '/.claude/settings.json'), apiKey: 'ANTHROPIC_API_KEY' in process.env }) + '\\n');
if (verb === 'login') { if (${login}) writeFileSync(home + '/.signed-in', 'yes'); process.exit(${login} ? 0 : 3); }
console.log(JSON.stringify({ loggedIn: ${loggedIn} && existsSync(home + '/.signed-in') }));
`;
 const authenticate = async (script, ...args) => {
  await writeFile(join(bin, 'claude'), script, { mode: 0o755 });
  await rm(join(state, 'executor-home'), { recursive: true, force: true });
  await rm(join(root, 'calls.jsonl'), { force: true });
  const result = await companion(['claude-auth', ...args], { home, state, env: { PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'host-wide-key-must-not-pass' } });
  const calls = existsSync(join(root, 'calls.jsonl')) ? (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [];
  return { result, calls };
 };

 const ok = await authenticate(provider(true, true));
 assert.equal(ok.result.code, 0, ok.result.stderr);
 assert.deepEqual(ok.calls.map(call => [call.group, call.verb, call.rest]), [['auth', 'login', ['--claudeai']], ['auth', 'status', ['--json']]]);
 assert.ok(ok.calls.every(call => call.home === join(state, 'executor-home') && !call.hostConfiguration && !call.apiKey), 'only the dedicated home: no host configuration, no host-wide API key');
 assert.equal(await mode(join(state, 'executor-home')), 0o700);

 const consoleLogin = await authenticate(provider(true, true), '--console');
 assert.equal(consoleLogin.result.code, 0, consoleLogin.result.stderr);
 assert.deepEqual(consoleLogin.calls[0].rest, ['--console']);

 const unconfirmed = await authenticate(provider(true, false));
 assert.notEqual(unconfirmed.result.code, 0, 'a login the provider does not confirm is not success');

 const failed = await authenticate(provider(false, true));
 assert.notEqual(failed.result.code, 0);
 assert.deepEqual(failed.calls.map(call => call.verb), ['login'], 'status is not consulted after a failed login');
});
