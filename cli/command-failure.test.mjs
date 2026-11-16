import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { isolatedQueue } from './fixtures/queue.mjs';
import { buildPackage } from '../scripts/rer-package.mjs';
import { readPackage, writePackage } from '../global/update/archive.mjs';

const base = join(import.meta.dirname, '..');
const source = path => pathToFileURL(join(base, path)).href;

test('dev respects the caller tool order and reports the failing command, status, redacted tail and readable full log', { timeout: 60000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-command-failure-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const home = join(root, 'home'), tools = join(root, 'tools'), runtime = join(root, 'runtime');
 for (const path of [home, tools, runtime]) await mkdir(path);
 // Real Node with an unrelated, broken sibling: promoting its directory would
 // select that sibling instead of the caller's deliberately earlier Git.
 const node = join(runtime, 'node');
 await copyFile(process.execPath, node); await chmod(node, 0o700);
 // Homebrew Node loads libnode beside its executable; official Node is static.
 const libraries = join(dirname(process.execPath), '..', 'lib');
 for (const name of await readdir(libraries).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
  if (/^libnode\..*\.dylib$/.test(name)) await symlink(join(libraries, name), join(runtime, name));
 }
 await writeFile(join(runtime, 'git'), '#!/bin/sh\necho wrong Git beside Node >&2\nexit 32\n', { mode: 0o700 });
 await writeFile(join(tools, 'git'), '#!/bin/sh\necho caller Git cannot run this checkout >&2\necho "Authorization: Bearer test-only-failing-tool-token" >&2\nexit 27\n', { mode: 0o700 });
 await writeFile(join(tools, 'pnpm'), '#!/bin/sh\necho 0.0.0\n', { mode: 0o700 });
 const pins = JSON.parse(await readFile(join(base, 'default-seed/package.json'), 'utf8'));
 const version = pins.packageManager.slice('pnpm@'.length);
 // Only the package manager's version edge is a fixture; dev reaches the
 // declared Git migration through the real adapter and captured runner.
 const cached = join(home, '.rer', 'pnpm', 'pnpm-' + version);
 for (const path of [join(home, '.rer'), join(home, '.rer/pnpm'), cached, join(cached, 'bin'), join(cached, 'shim')]) await mkdir(path, { mode: 0o700 });
 const entry = `console.log(${JSON.stringify(version)});\n`;
 await writeFile(join(cached, 'bin/pnpm.cjs'), entry, { mode: 0o600 });
 await writeFile(join(cached, 'shim/pnpm'), `#!${node}\n${entry}`, { mode: 0o700 });
 await writeFile(join(cached, '.rer-verified.json'), JSON.stringify({ version, integrity: 'sha512-' + createHash('sha512').update(entry).digest('base64'), entrySha256: createHash('sha256').update(entry).digest('hex') }), { mode: 0o600 });
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: pins.packageManager }));
 await writeFile(join(root, 'adapter.mjs'), `
import { localInstaller } from ${JSON.stringify(source('onboarding/adapter.mjs'))};
import { commandAdapter as declare } from ${JSON.stringify(source('cli/adapter.mjs'))};
const lifecycle = localInstaller({ tools: [], secrets: { file: '.dev.vars', format: 'dotenv', originKey: 'AUTH_ORIGIN' }, migrate: ['git', ['--rer-diagnostic-test']] });
export const commandAdapter = declare(lifecycle, { scheduled: false });
`);
 const descriptor = { version: 2, project: 'example/command-failure', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { dev: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Run the declared local migration.' } } };
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 const socket = createServer();
 await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
 const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
 await writeFile(join(root, '.dev.vars'), `OWNER_EMAIL=owner@example.test\nAUTH_ORIGIN=http://127.0.0.1:${port}\n`, { mode: 0o600 });
 const env = await isolatedQueue(t, { ...process.env, HOME: home, PATH: tools + delimiter + process.env.PATH, CI: 'true' });
 delete env.RER_PNPM_ENTRY;
 const run = args => {
  const result = spawnSync(node, [join(base, 'bin/rer.mjs'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error); return result;
 };
 const check = async (text, status = 'exit 27') => {
  assert.ok(text.includes(status), text);
  assert.match(text, /Command: git/);
  assert.match(text, /Last output[^]*caller Git cannot run this checkout/);
  assert.doesNotMatch(text, /wrong Git beside Node|test-only-failing-tool-token/);
  const log = /Log: (.+)/.exec(text)?.[1];
  assert.ok(log, text);
  const full = await readFile(log, 'utf8');
  if (!log.startsWith(root)) t.after(() => rm(dirname(log), { recursive: true, force: true }));
  assert.match(full, /caller Git cannot run this checkout/);
  assert.doesNotMatch(full, /test-only-failing-tool-token/);
 };
 const human = run(['dev']);
 assert.equal(human.status, 1, human.stdout + human.stderr);
 await check(human.stderr);
 const json = run(['dev', '--json']);
 assert.equal(json.status, 1, json.stdout + json.stderr);
 await check(json.stdout.trim().split('\n').map(JSON.parse).find(row => row.event === 'error').message);
 // A transfer hook can fail inside rer rather than in a captured subprocess.
 // Its native message stays private; the named log contains the safe failure.
 await writeFile(join(root,'adapter.mjs'),await readFile(join(root,'adapter.mjs'),'utf8')+`
commandAdapter.portability={export:async()=>{throw new Error('unreachable export');}};
commandAdapter.prepareData=async(root,store)=>{
 await store.step('Inspecting local export data');
 throw new RangeError('private row diagnostic sentinel');
};
`);
 descriptor.commands.export={argv:['node','adapter.mjs'],inputs:['adapter.mjs'],effects:'Export local installation data.'};
 await writeFile(join(root,'OPERATIONS.json'),JSON.stringify(descriptor));
 for(const json of [false,true]) {
  const failure=run(['export','--output','exports/failed.rer',...(json?['--json']:[])]);
  assert.equal(failure.status,1,failure.stdout+failure.stderr);
  const message=json?failure.stdout.trim().split('\n').map(JSON.parse).find(event=>event.event==='error').message:failure.stderr;
  assert.match(message,/Inspecting local export data failed \(RangeError\)/);
  assert.doesNotMatch(failure.stdout+failure.stderr,/private row diagnostic sentinel/);
  const path=/Full output: (.+)/.exec(message)?.[1];
  assert.ok(path,message);
  const log=await readFile(join(root,path),'utf8');
  assert.match(log,/command_failed: Inspecting local export data failed \(RangeError\)/);
  assert.doesNotMatch(log,/private row diagnostic sentinel/);
 }
 // The dispatcher is outside the checkout's installed package, as when an
 // agent explicitly invokes an updated CLI on a checkout with an older pin.
 // Use a real packed copy: its refusal must retain the selected CLI's status.
 const packed=await buildPackage(base,join(root,'packed'));
 await writePackage(readPackage(await readFile(packed)),join(root,'node_modules/@runeditrun/rer'));
 await writeFile(join(root,'adapter.mjs'),`
import {localInstaller} from ${JSON.stringify(source('onboarding/adapter.mjs'))};
import {commandAdapter as declare} from ${JSON.stringify(source('cli/adapter.mjs'))};
import {localPortability} from '@runeditrun/rer/portability';
export const commandAdapter=declare(localInstaller({tools:[]}),{
 portability:localPortability({database:'unused',policy:{product:'synthetic-command-failure',exportRow:row=>row}}),scheduled:false,
});
`);
 const policyRefusal=run(['export','--output','exports/refused.rer','--json']);
 assert.equal(policyRefusal.status,4,policyRefusal.stdout+policyRefusal.stderr);
 const policyError=policyRefusal.stdout.trim().split('\n').map(JSON.parse).find(event=>event.event==='error');
 assert.equal(policyError.code,'safety_refusal');
 assert.match(policyError.message,/policy_module_required/);
 // Independent verbs use the same diagnostic and keep their full log after
 // returning the declared command's original numeric or signal status.
 delete descriptor.seedContract;
 descriptor.commands = Object.fromEntries(['dev', 'verify'].map(verb => [verb, { argv: ['git', '--rer-diagnostic-test'], inputs: [], effects: 'Run the project-owned tool.' }]));
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 for (const verb of ['dev', 'verify']) {
  const result = run([verb]);
  assert.equal(result.status, 27, result.stdout + result.stderr);
  await check(result.stderr);
 }
 await writeFile(join(tools, 'git'), '#!/bin/sh\necho caller Git cannot run this checkout >&2\nkill -TERM $$\n', { mode: 0o700 });
 const signalled = run(['dev']);
 assert.equal(signalled.status, 143, signalled.stdout + signalled.stderr);
 await check(signalled.stderr, 'signal SIGTERM');
});
