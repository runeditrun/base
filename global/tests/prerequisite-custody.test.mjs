import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const base = resolve(import.meta.dirname, '../..'), root = join(base, 'default-seed');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);

// A pnpm release whose bin runs `script`, served by the fixture network edge, and
// a bootstrap entry that acquires it into a private HOME holding only tar and gzip.
async function acquisition(temporary, pin, edge, script, name = 'acquired') {
 const source = join(temporary, `${name}-release`), archive = join(temporary, `${name}.tgz`), home = join(temporary, name), tools = join(home, 'tools');
 await mkdir(join(source, 'package/bin'), { recursive: true }); await mkdir(tools, { recursive: true });
 // System directories can already contain the exact pnpm on CI. Expose only
 // the real extraction tools so acquisition never depends on the host's pnpm.
 for (const tool of ['tar', 'gzip']) {
  const { stdout } = await execute('/bin/sh', ['-c', `command -v ${tool}`]);
  await symlink(stdout.trim(), join(tools, tool));
 }
 await writeFile(join(source, 'package/package.json'), JSON.stringify({ version: pin }));
 await writeFile(join(source, 'package/bin/pnpm.cjs'), script);
 await execute('tar', ['-czf', archive, '-C', source, 'package']);
 const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
 const entry = join(temporary, `${name}.mjs`), resultFile = join(home, 'result.json'), requests = join(home, 'requests.jsonl');
 await writeFile(entry, `import {writeFile} from 'node:fs/promises';import {ensureProjectPnpm} from ${JSON.stringify(pathToFileURL(join(base, 'cli/project-pnpm.mjs')).href)};try{await ensureProjectPnpm(${JSON.stringify(root)});}catch(error){console.error(error.message);process.exit(error.exitCode??1);}await writeFile(${JSON.stringify(resultFile)},JSON.stringify({PATH:process.env.PATH}));\n`);
 const env = { ...process.env, HOME: home, PATH: tools, NODE_OPTIONS: `--import=${pathToFileURL(edge).href}`, PROBE_REQUESTS: requests, PROBE_ARCHIVE: archive, PROBE_PIN: pin, PROBE_INTEGRITY: integrity };
 return { home, resultFile, requests, run: start => start([entry], env).done };
}

// The real public bootstrap runs against the maintained checkout. Only its
// network and pnpm probes are fixtures; no application operation is simulated.
test('fresh bootstrap provisions the declared pnpm privately and retires probe custody before failure or cancellation', { timeout: 45000 }, async t => {
 const temporary = await mkdtemp(join(tmpdir(), 'rer-prerequisite-custody-'));
 let wrapper, owned = [];
 t.after(async () => {
  if (wrapper?.exitCode === null && wrapper?.signalCode === null) { wrapper.kill('SIGTERM'); await wrapper.done; }
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await rm(temporary, { recursive: true, force: true });
 });
 const pin = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager.replace(/^pnpm@/, '');
 const edge = join(temporary, 'edge.mjs');
 await writeFile(edge, `import {appendFileSync,readFileSync} from 'node:fs';
globalThis.fetch=async url=>{
 appendFileSync(process.env.PROBE_REQUESTS,JSON.stringify(url)+'\\n');
 if(!process.env.PROBE_ARCHIVE)throw Error('offline prerequisite fixture');
 return new Response(url.endsWith('.tgz')?readFileSync(process.env.PROBE_ARCHIVE):JSON.stringify({version:process.env.PROBE_PIN,dist:{integrity:process.env.PROBE_INTEGRITY}}));
};\n`);
 const start = (argv, env) => {
  wrapper = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  wrapper.stdout.on('data', chunk => { stdout += chunk; }); wrapper.stderr.on('data', chunk => { stderr += chunk; });
  wrapper.done = new Promise(resolve => wrapper.once('close', code => resolve({ code, stdout, stderr })));
  return wrapper;
 };
 for (const mode of ['exit', 'timeout', 'cancel']) {
  const home = join(temporary, mode), bin = join(home, 'bin'), requests = join(home, 'requests.jsonl');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'pnpm'), `#!${process.execPath}\nconst{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();writeFileSync(process.env.HOME+'/owned.json',JSON.stringify([process.pid,c.pid]));${mode === 'exit' ? "console.log('different version')" : 'setInterval(()=>{},1000)'}\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: bin, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${pathToFileURL(edge).href}`, PROBE_REQUESTS: requests };
  start([join(base, 'global/rer.mjs'), 'install'], env);
  const deadline = Date.now() + 10000;
  while (!owned.length && Date.now() < deadline && wrapper.exitCode === null) {
   owned = await readFile(join(home, 'owned.json'), 'utf8').then(JSON.parse).catch(() => []);
   if (!owned.length) await pause(20);
  }
  assert.equal(owned.length, 2, 'the prerequisite probe started');
  if (mode === 'cancel') wrapper.kill('SIGTERM');
  const result = await wrapper.done;
  assert.equal(result.code, mode === 'cancel' ? 143 : 3, result.stderr);
  for (const pid of owned) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  owned = [];
  if (mode === 'cancel') await assert.rejects(readFile(requests), { code: 'ENOENT' });
  else {
   assert.match(result.stderr, /npm install --prefix .* --no-save pnpm@.* && export PATH=/);
   assert.ok(result.stderr.includes(home) && result.stderr.includes(`pnpm@${pin}`), result.stderr);
  }
 }
 // Exercise successful integrity-bound acquisition through that same command
 // store, without running an application with a fixture package manager.
 const { home, resultFile, requests, run } = await acquisition(temporary, pin, edge, `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();writeFileSync(process.env.HOME+'/owned.json',JSON.stringify([process.pid,c.pid]));console.log(${JSON.stringify(pin)});\n`);
 const acquired = await run(start);
 owned = await readFile(join(home, 'owned.json'), 'utf8').then(JSON.parse).catch(() => []);
 assert.equal(acquired.code, 0, acquired.stderr);
 assert.equal(owned.length, 2, 'the acquired package ran its version probe');
 for (const pid of owned) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
 owned = [];
 const supplied = JSON.parse(await readFile(resultFile, 'utf8'));
 assert.ok(supplied.PATH.split(':').some(directory => directory.startsWith(home + '/')), 'the acquired tool is private to the supplied HOME');
 assert.ok((await readFile(requests, 'utf8')).trim(), 'the private tool was acquired from the network edge');
});

// A fresh pnpm whose first version check fails (a cold start on a busy machine)
// settles on the bounded retry; one that keeps failing is refused naming what it said.
test('the pinned pnpm check settles a transient failure and names a lasting one', { timeout: 45000 }, async t => {
 const temporary = await mkdtemp(join(tmpdir(), 'rer-prerequisite-settle-'));
 t.after(() => rm(temporary, { recursive: true, force: true }));
 const pin = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager.replace(/^pnpm@/, '');
 const edge = join(temporary, 'edge.mjs');
 await writeFile(edge, `import {readFileSync} from 'node:fs';
globalThis.fetch=async url=>new Response(url.endsWith('.tgz')?readFileSync(process.env.PROBE_ARCHIVE):JSON.stringify({version:process.env.PROBE_PIN,dist:{integrity:process.env.PROBE_INTEGRITY}}));\n`);
 const start = (argv, env) => {
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.done = new Promise(resolve => child.once('close', code => resolve({ code, stderr })));
  return child;
 };
 const failing = failures => `const{readFileSync,writeFileSync}=require('node:fs');const f=process.env.HOME+'/runs';const n=Number(readFileSync(f,'utf8').trim()||0)+1;writeFileSync(f,String(n));if(n<=${failures}){console.error('fixture pnpm cold start failed');process.exit(1);}console.log(${JSON.stringify(pin)});\n`;
 const transient = await acquisition(temporary, pin, edge, failing(1), 'transient');
 await writeFile(join(transient.home, 'runs'), '0');
 const settled = await transient.run(start);
 assert.equal(settled.code, 0, settled.stderr);
 assert.equal((await readFile(join(transient.home, 'runs'), 'utf8')).trim(), '2', 'one failed check, then one that settled');
 const lasting = await acquisition(temporary, pin, edge, failing(99), 'lasting');
 await writeFile(join(lasting.home, 'runs'), '0');
 const refused = await lasting.run(start);
 assert.equal(refused.code, 3, refused.stderr);
 assert.match(refused.stderr, /exited 1: fixture pnpm cold start failed/, 'the refusal names what pnpm did');
 assert.equal((await readFile(join(lasting.home, 'runs'), 'utf8')).trim(), '3', 'the retry is bounded');
});
