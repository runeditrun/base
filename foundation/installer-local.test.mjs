import { checkCases } from '../onboarding/test-fixture.mjs';
import {exportCLI} from '../cli/export.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { stopChild } from '../onboarding/private.mjs';

async function fixture(build, healthStatus = 200, healthBody = { status: 'ok' }, applicationSource) {
 const root = await mkdtemp(resolve(tmpdir(), 'foundation-local-'));
 await cp(resolve(import.meta.dirname, 'template/scripts/installer'), resolve(root, 'scripts/installer'), { recursive: true });
 await cp(resolve(import.meta.dirname, '../onboarding'), resolve(root, 'scripts/base-onboarding'), { recursive: true });
 await exportCLI(resolve(import.meta.dirname,'..'),root);
 await mkdir(resolve(root, 'src'), { recursive: true });
 await mkdir(resolve(root, 'bin'), { recursive: true });
 await mkdir(resolve(root, 'node_modules/wrangler/bin'), { recursive: true });
 await writeFile(resolve(root, 'build.mjs'), build);
 // Test-only package-manager fixture executes an actual child build, keeping the
 // adapter's production command routing and capture plumbing intact.
 await writeFile(resolve(root, 'bin/pnpm'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');if(process.argv[2]==='run'){const result=spawnSync(process.execPath,['build.mjs'],{stdio:'inherit'});process.exit(result.status??1)}\n`, { mode: 0o700 });
 await writeFile(resolve(root, 'node_modules/wrangler/bin/wrangler.js'), applicationSource ?? `const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('--port')+1]);http.createServer((req,res)=>{res.statusCode=${healthStatus};res.setHeader('content-type','application/json');res.end(${JSON.stringify(JSON.stringify(healthBody))})}).listen(port,'127.0.0.1');`);
 // Retain these captured-runner regressions as a library fixture. The template
 // now requires real D1/owner/mail; its application acceptance uses real exports.
 const { localInstaller } = await import(pathToFileURL(resolve(root,'scripts/base-onboarding/adapter.mjs')));
 const { selectLocalState } = await import('../onboarding/local/state.mjs');
 const { install } = localInstaller({
  async prepare(context) { context.localState=await selectLocalState(context.root);await context.store.step('Saving application branding');await writeFile(resolve(context.root,'src/branding.json'),JSON.stringify(context.input)); },
  build:['pnpm',['run','build']],
  start:({origin,localState})=>[process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local','--config','dist/server/wrangler.json','--persist-to',localState,'--ip','127.0.0.1','--port',new URL(origin).port]],
 });
 const { createState } = await import(pathToFileURL(resolve(root, 'scripts/base-onboarding/state.mjs')));
 const store = await createState(root, { product: 'Foundation fixture', model: { safeKeys: ['name', 'primaryColor'] } });
 const originalPath = process.env.PATH;
 process.env.PATH = resolve(root, 'bin') + ':' + originalPath;
 let child;
 return { root, store, install, register(value) { child = value; }, async close() {
  process.env.PATH = originalPath;
  if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); stopChild(child); await closed; }
  await store.closeCommands(); await rm(root, { recursive: true, force: true });
 } };
}

test("foundation local start retains cleanup custody and diagnostics through healthy, exited and failed startup", () => checkCases([
  ['foundation failed attempt awaits delayed application termination and final pipe output', async () => {
 const f = await fixture(`console.log('build completed');`, 503, undefined, `
  const http=require('node:http');
  process.on('SIGTERM',()=>setTimeout(()=>{
   console.log('application cleanup completed');
   process.exit(0);
  },300));
  const port=Number(process.argv[process.argv.indexOf('--port')+1]);
  http.createServer((req,res)=>{res.statusCode=503;res.end()}).listen(port,'127.0.0.1');
 `);
 let child, closed = false;
 const waitForReady = f.store.waitForReady.bind(f.store), phase = f.store.phase.bind(f.store);
 f.store.waitForReady = (label, child, health, options) => waitForReady(label, child, health, { ...options, timeoutMs: 500, intervalMs: 10 });
 f.store.phase = async value => {
  if (value === 'failed') assert.ok(closed, 'failed phase follows application close');
  await phase(value);
 };
 try {
  await f.install(f.root, input, f.store, value => {
   child = value; f.register(value); value.once('close', () => { closed = true; });
  });
  assert.equal(f.store.state.phase, 'failed');
  assert.equal(child.exitCode, 0, 'SIGTERM handler completed its delayed cleanup');
  assert.ok(closed, 'failed attempt returns only after pipe close');
  assert.match(f.store.state.error, /Last health: HTTP 503/);
  assert.match(f.store.state.logs.join('\n'), /application cleanup completed/);
 } finally { await f.close(); }
}],
  ...[
 ['process.exit(7)', 7, null, /exit 7/],
 ["process.kill(process.pid,'SIGTERM')", null, 'SIGTERM', /signal SIGTERM/],
].map([exit, code, signal, diagnostic] => [`foundation application ${signal ?? `exit ${code}`} completes failure without signalling its retired PID`, async () => {
 const f = await fixture(`console.log('build completed');`, undefined, undefined, `console.error('application final failure detail');${exit};`);
 let child, closed = false;
 const stop = f.store.stop.bind(f.store);
 f.store.stop = async value => {
  assert.equal(value, child);
  assert.ok(closed, 'readiness drains output from an application that already exited');
  const kill = process.kill;
  process.kill = (pid, ...args) => {
   assert.notEqual(Math.abs(pid), child.pid, 'retired application PID must never be signalled');
   return kill.call(process, pid, ...args);
  };
  try { await stop(value); } finally { process.kill = kill; }
 };
 try {
  await f.install(f.root, input, f.store, value => {
   child = value; f.register(value); value.once('close', () => { closed = true; });
  });
  assert.equal(f.store.state.phase, 'failed');
  assert.equal(child.exitCode, code);
  assert.equal(child.signalCode, signal);
  assert.ok(closed);
  assert.match(f.store.state.error, diagnostic);
  assert.match(f.store.state.error, /application final failure detail/);
 } finally { await f.close(); }
}]),
  ['foundation failing build retains actual final output in approved diagnostics', async () => {
 const f = await fixture(`for(let i=0;i<80;i++)console.log('build progress '+i);console.error('final compiler detail: missing exported symbol');console.error('final build line: source compilation failed');process.exit(7);`);
 try {
  await f.install(f.root, input, f.store, () => assert.fail('failed build cannot start app'));
  assert.equal(f.store.state.phase, 'failed');
  assert.match(f.store.state.error, /exit 7/);
  assert.match(f.store.state.error, /final compiler detail: missing exported symbol/);
  assert.match(f.store.state.error, /final build line: source compilation failed/);
  assert.match(await readFile(f.store.logPath, 'utf8'), /final build line: source compilation failed/);
 } finally { await f.close(); }
}],
  ['foundation local start completes after transient unhealthy responses', async () => {
 const f = await fixture(`console.log('build completed');`, undefined, undefined, `
  const http=require('node:http');let checks=0;
  const port=Number(process.argv[process.argv.indexOf('--port')+1]);
  http.createServer((req,res)=>{res.statusCode=++checks<=2?503:200;res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}));}).listen(port,'127.0.0.1');
 `);
 let registered = false, retried = false;
 const waitForReady = f.store.waitForReady.bind(f.store);
 f.store.waitForReady = async (label, child, health, options) => {
  assert.ok(registered, 'child registration precedes readiness');
  return waitForReady(label, child, async signal => {
   const result=await health(signal);if(!result.ready)retried=true;return result;
  }, { ...options, intervalMs: 25, timeoutMs: 30000 });
 };
 try {
  await f.install(f.root, input, f.store, child => { registered = true; f.register(child); });
  assert.equal(f.store.state.phase, 'complete', f.store.state.error);
  assert.equal(retried, true, 'installation retries a not-ready health transport');
  assert.equal((await fetch(f.store.state.appUrl + '/health')).status, 200);
 } finally { await f.close(); }
}],
  ...[
 [503, { status: 'private response body must stay private' }, /Last health: HTTP 503/],
 [200, { status: 'private response body must stay private' }, /Last health: HTTP 200; health status not ok/],
].map([status, body, diagnostic] => [`foundation readiness deadline records actual HTTP ${status} health status`, async () => {
  const f = await fixture(`console.log('build completed');`, status, body);
  const waitForReady = f.store.waitForReady.bind(f.store);
  f.store.waitForReady = (label, child, health, options) => waitForReady(label, child, health, { ...options, timeoutMs: 1000, intervalMs: 20, softAfterMs: 30 });
  try {
   await f.install(f.root, input, f.store, f.register);
   assert.equal(f.store.state.phase, 'failed');
   assert.match(f.store.state.error, /readiness deadline exceeded/);
   assert.match(f.store.state.error, diagnostic);
   assert.doesNotMatch(f.store.state.error, /private response body/);
  } finally { await f.close(); }
 }])
]));


const input = { APP_NAME: 'Local fixture', PRIMARY_COLOR: '#356c60' };
