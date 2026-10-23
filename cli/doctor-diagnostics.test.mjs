import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cli = join(import.meta.dirname, '../bin/rer.mjs');

test('doctor reports every failed check in complete JSON and keeps human output separate', { timeout: 30000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-doctor-diagnostics-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const home = join(root, 'home'), emptyPath = join(root, 'empty-bin');
 await Promise.all([mkdir(home), mkdir(emptyPath)]);
 await writeFile(join(root, 'adapter.mjs'), "export const commandAdapter = { version: 1, state: 'dist/state', hooks: { secrets: { file: '.dev.vars' } } };\n");
 // The project pins a Node this shell does not run.
 const pinnedNode = process.versions.node === '20.0.0' ? '20.0.1' : '20.0.0';
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: pinnedNode } }));
 await writeFile(join(root, 'configuration.mjs'), 'export function validateConfiguration(env) { throw Error(`Invalid private input: ${env.SESSION_SECRET}`); }\n');
 // A real project with many unavailable targets makes the report larger than
 // a pipe buffer. Nothing executes those targets or substitutes a tool binary.
 const commands = Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [
  `verify-unavailable-product-component-${index}`,
  { argv: ['node', 'missing.mjs'], inputs: ['missing.mjs'], effects: 'Check this product component.' },
 ]));
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({
  version: 2, project: 'example/doctor-diagnostics', runtime: { requirements: [] }, requiredEnvironment: [],
  configuration: { module: 'configuration.mjs' }, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands,
 }));
 const secret = 'synthetic-private-doctor-input';
 const env = { PATH: emptyPath, HOME: home, TZ: 'UTC', RER_NODE_AUTO: '0', SESSION_SECRET: secret };
 const run = async args => {
  // Shell redirection supplies a real OS pipe; Node's direct child stdout is
  // a socket on some platforms and does not reproduce a piped terminal command.
  const pipe = '"$1" "$2" doctor "${@:3}" | "$1" -e \'setTimeout(() => process.stdin.pipe(process.stdout), 100)\'';
  const child = spawn('/bin/bash', ['-o', 'pipefail', '-c', pipe, 'doctor-pipe', process.execPath, cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 3, stderr);
  assert.ok(!(stdout + stderr).includes(secret), 'private validator inputs stay suppressed');
  return stdout;
 };
 const stdout = await run(['--json']);
 if (process.env.RER_TEST_EVIDENCE_DIRECTORY) await writeFile(join(process.env.RER_TEST_EVIDENCE_DIRECTORY, 'doctor.json'), stdout);
 const events = stdout.trim().split('\n').map(line => JSON.parse(line));
 assert.equal(events.length, 1, 'JSON mode emits one structured result without a human summary');
 const { diagnostics, ok, exitCode } = events[0];
 assert.equal(ok, false);
 assert.equal(exitCode, 3);
 assert.equal(diagnostics.operations.configuration, 'invalid');
 assert.deepEqual(diagnostics.operations.commands, Object.keys(commands).map(name => ({ name, available: false })));
 assert.equal(diagnostics.state.safe, false);
 assert.ok(diagnostics.state.issue.includes('dist'), 'the state issue names the overlapping location');
 assert.ok(diagnostics.pnpm.issue.includes('packageManager') && diagnostics.pnpm.issue.includes('pnpm --version'), 'the pnpm issue names the declaration to correct and the command that failed');
 assert.deepEqual([diagnostics.node.expected, diagnostics.node.actual], [pinnedNode, process.versions.node]);
 const human = await run([]);
 if (process.env.RER_TEST_EVIDENCE_DIRECTORY) await writeFile(join(process.env.RER_TEST_EVIDENCE_DIRECTORY, 'doctor-human.txt'), human);
 const summaryAt = human.lastIndexOf('\ndoctor:');
 assert.ok(summaryAt > 0, 'human mode puts its summary on a separate line after the report');
 assert.throws(() => JSON.parse(human.slice(0, summaryAt)), 'human mode is readable text');
 const unavailable = /^Unavailable command inputs:\n((?: {2}[^\n]+\n)+)/m.exec(human)?.[1];
 assert.ok(unavailable, 'human report identifies unavailable command inputs');
 const reportedCommands = unavailable.trimEnd().split('\n').map(line => /^ {2}([^:]+):/.exec(line)?.[1]);
 assert.deepEqual(reportedCommands, diagnostics.operations.commands.filter(command => !command.available).map(command => command.name));
 assert.ok(human.includes(diagnostics.state.issue));
 assert.ok(human.includes(diagnostics.pnpm.issue));
 // The failed Node check comes with its next action: here automatic selection is off.
 const nodeCheck = human.split('\n').findIndex(line => line.startsWith('Node:'));
 assert.ok(human.split('\n').slice(nodeCheck, nodeCheck + 2).join('\n').includes('RER_NODE_AUTO'), human);
});

test('local doctor succeeds without deployment credentials and still refuses missing local settings', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-doctor-local-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, 'home'));
 await symlink(join(import.meta.dirname, '../default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'adapter.mjs'), "export const commandAdapter={version:1,state:'.wrangler/state',hooks:{secrets:{file:'.dev.vars'}}};\n");
 const deploymentInputs = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'synthetic-doctor-1', runtime: { requirements: [] }, requiredEnvironment: deploymentInputs, seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { dev: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Run this checkout locally.' } } }));
 const invoke = async (json, PATH = process.env.PATH) => {
  const child = spawn(process.execPath, [cli, 'doctor', ...(json ? ['--json'] : [])], { cwd: root, env: { PATH, HOME: join(root, 'home'), TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr, ...(json ? { result: JSON.parse(stdout) } : {}) };
 };
 await writeFile(join(root, '.dev.vars'), 'OWNER_EMAIL=owner@example.test\nAUTH_ORIGIN=http://localhost:8787\n');
 const healthy = await invoke(true);
 assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
 assert.equal(healthy.result.diagnostics.ok, true);
 assert.deepEqual(healthy.result.diagnostics.missingInputs, []);
 assert.deepEqual(healthy.result.diagnostics.deploymentInputs, deploymentInputs);
 const human = await invoke(false);
 assert.equal(human.code, 0, human.stdout + human.stderr);
 assert.throws(() => JSON.parse(human.stdout));
 for (const name of deploymentInputs) assert.ok(human.stdout.includes(name));
 // Without the pinned pnpm on PATH or in rer's cache, the failed check names the command that fetches it.
 await mkdir(join(root, 'empty-bin'));
 const noPnpm = await invoke(false, join(root, 'empty-bin'));
 assert.equal(noPnpm.code, 3, noPnpm.stdout + noPnpm.stderr);
 assert.ok(noPnpm.stdout.includes('rer install'), noPnpm.stdout);
 await writeFile(join(root, '.dev.vars'), 'AUTH_ORIGIN=http://localhost:8787\n');
 const missing = await invoke(true);
 assert.equal(missing.code, 3, missing.stdout + missing.stderr);
 assert.deepEqual(missing.result.diagnostics.missingInputs, ['OWNER_EMAIL']);
});
