import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const cli = join(import.meta.dirname, '../bin/rer.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const cancel of [false, true]) test(`doctor tool custody stops quiet descendants after ${cancel ? 'interruption' : 'leader exit'}`, { timeout: 20000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-doctor-custody-')); let wrapper, owned = [];
 t.after(async () => {
  if (wrapper?.exitCode === null && wrapper?.signalCode === null) { wrapper.kill('SIGTERM'); await wrapper.done; }
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await rm(root, { recursive: true, force: true });
 });
 await mkdir(join(root, 'bin'));
 await writeFile(join(root, 'adapter.mjs'), "export const commandAdapter={version:1,state:'.wrangler/state',hooks:{secrets:{file:'.dev.vars'}}};\n");
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/doctor', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { doctor: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Read-only diagnostics.' } } }));
 await writeFile(join(root, 'bin/pnpm'), `#!${process.execPath}\nconst {spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('owned.json',JSON.stringify([process.pid,c.pid]));c.unref();${cancel ? "console.log('PROBE_STARTED');setInterval(()=>{},1000)" : "console.log('10.12.4')"}\n`, { mode: 0o700 });
 wrapper = spawn(process.execPath, [cli, 'doctor', '--json'], { cwd: root, env: { PATH: join(root, 'bin') + ':' + process.env.PATH, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
 let stdout = '', stderr = ''; wrapper.stdout.on('data', chunk => { stdout += chunk; }); wrapper.stderr.on('data', chunk => { stderr += chunk; });
 wrapper.done = new Promise(resolve => wrapper.once('close', code => resolve(code)));
 if (cancel) {
  const deadline = Date.now() + 10000;
  while (!stderr.includes('PROBE_STARTED') && Date.now() < deadline && wrapper.exitCode === null) await pause(20);
  assert.match(stderr, /PROBE_STARTED/); wrapper.kill('SIGTERM');
 }
 const code = await wrapper.done;
 owned = JSON.parse(await readFile(join(root, 'owned.json'), 'utf8'));
 assert.equal(code, cancel ? 143 : 3, stderr);
 assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).exitCode, code);
 for (const pid of owned) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
 owned = [];
});
