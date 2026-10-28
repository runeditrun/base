// Saved setup ports belong to live launches; stopped checkouts do not reserve
// the finite automatic search range. Setup still moves past a bind race.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { processInfo } from '../../modules/job-queue/processes.mjs';
import { probePort } from '../../onboarding/port-probe.mjs';
import { launchPath, liveWorker, serverRecord } from '../launch/state.mjs';
import { processesIn, run } from './harness.mjs';
import { portCheckout } from './fixtures/port-checkout.mjs';

const base = resolve(import.meta.dirname, '../..');
const close = server => new Promise(resolveClose => server.close(resolveClose));
async function bind(port) {
 const server = createServer();
 try {
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  return server;
 } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
}
async function stopped(root) {
 const deadline = Date.now() + 30_000;
 while ((await processesIn(root)).length && Date.now() < deadline) await delay(100);
 assert.deepEqual((await processesIn(root)).map(item => item.command), [], 'the owned fixture processes stopped');
}
async function stopServer(directory) {
 const record = await serverRecord.read(directory);
 if (!record) return;
 const current = await processInfo(record.pid);
 if (current && !current.zombie && current.start === record.start) process.kill(record.pid, 'SIGTERM');
}

test('a zero-setup rer dev reclaims stale saved ports, keeps live owners and moves past a port another process takes', { timeout: 5 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-port-')), root = join(directory, 'synthetic-base-1'), fresh = join(directory, 'synthetic-base-1204');
 const from = Number(process.env.RER_TEST_PORTS?.split('-')[0] ?? 8787), last = from + 999;
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', RER_UPDATE_CHECK: '0', RER_SERVERS_DIR: join(directory, 'servers'), ...(from === 8787 ? {} : { RER_DEV_PORT_FROM: String(from) }), ...Object.fromEntries(['TMPDIR'].filter(name => process.env[name]).map(name => [name, process.env[name]])) });
 const rer = (args, cwd = root) => run(process.execPath, [join(base, 'global/rer.mjs'), ...args], { cwd, env });
 let own, freshLaunch;
 const bound = [];
 t.after(async () => {
  try {
   if (own) {
    const worker = await liveWorker(own);
    if (worker) process.kill(worker.pid, 'SIGTERM');
    await stopServer(own);
   }
   if (freshLaunch) {
    const worker = await liveWorker(freshLaunch);
    if (worker) process.kill(worker.pid, 'SIGTERM');
    await stopServer(freshLaunch);
   }
   const holder = await readFile(join(directory, 'holder.pid'), 'utf8').catch(() => '');
   if (holder) try { process.kill(Number(holder), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
   await stopped(root);
   await stopped(fresh);
  } finally {
   for (const server of bound) await close(server);
   await rm(directory, { recursive: true, force: true });
  }
 });
 await portCheckout(root, directory);
 // Stopped launches retain their setup and server records, including records
 // whose PID now names another process with a different start identity.
 for (let i = 0; i < 1200; i++) {
  const saved = launchPath(join(directory, `synthetic-base-${i + 2}`), env);
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'setup.json'), JSON.stringify({ state: 'done', port: from + i, at: Date.now() }));
  if (i < 2) await writeFile(join(saved, i ? 'worker.json' : 'server.json'), JSON.stringify({ pid: process.pid, start: 'synthetic-base-1' }));
 }
 // Live launch owners reserve their saved port even before a listener binds.
 const available = [];
 for (let port = from; available.length < 3 && port <= last; port++) {
  if ((await probePort('127.0.0.1', port, { hosts: ['127.0.0.1', '::1'], searching: true })).available) available.push(port);
 }
 assert.equal(available.length, 3, 'three candidates are available before launching');
 const owner = await processInfo(process.pid);
 for (const [index, name] of ['worker.json', 'server.json'].entries()) {
  const saved = launchPath(join(directory, `synthetic-base-${index + 1202}`), env);
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'setup.json'), JSON.stringify({ state: 'done', port: available[index], at: Date.now() }));
  await writeFile(join(saved, name), JSON.stringify({ pid: owner.pid, start: owner.start }));
 }
 // An earlier failed install was repaired; it must not install again.
 own = launchPath(await realpath(root), env);
 await mkdir(own, { recursive: true });
 await writeFile(join(own, 'install.json'), JSON.stringify({ state: 'failed', at: Date.now() }));
 const launched = await rer(['dev']);
 assert.equal(launched.code, 0, launched.stderr + launched.stdout);
 assert.doesNotMatch(launched.stderr + launched.stdout, /installing dependencies/, 'current dependencies are kept');
 const taken = Number(await readFile(join(directory, 'taken-port'), 'utf8'));
 const ready = new URL(launched.stdout.match(/^RER_READY (\S+)$/m)?.[1] ?? 'http://invalid');
 assert.equal(taken, available[2], 'stopped records are reclaimed while both live owners are skipped');
 assert.ok(!available.slice(0, 2).includes(Number(ready.port)), 'live owner ports stay excluded');
 assert.ok(Number(ready.port) >= from && Number(ready.port) <= last, 'automatic start stays in the normal range');
 assert.notEqual(Number(ready.port), taken, 'the launch moves past the bind race');
 assert.match(launched.stderr, new RegExp(`port ${ready.port}`));
 assert.equal((await fetch(ready.origin + '/health')).status, 200);
 t.diagnostic(`1200 stale records; live worker port ${available[0]}, live server port ${available[1]}; raced port ${taken}; exit ${launched.code}; RER_READY ${ready.origin}; health 200`);
 await portCheckout(fresh, directory);
 freshLaunch = launchPath(await realpath(fresh), env);
 await mkdir(freshLaunch, { recursive: true });
 await writeFile(join(freshLaunch, 'install.json'), JSON.stringify({ state: 'failed', at: Date.now() }));
 // Every candidate must now be genuinely bound. Existing unrelated listeners
 // remain untouched; this case closes only sockets it creates itself.
 for (let port = from; port <= last; port++) {
  const server = await bind(port);
  if (server) bound.push(server);
 }
 const refused = await rer(['dev'], fresh);
 assert.equal(refused.code, 4, refused.stderr);
 assert.match(refused.stderr, new RegExp(`No free port from ${from} to ${last}: all 1000 ports tried were in use`));
 t.diagnostic(`1000 bound candidates; exit ${refused.code}; ${refused.stderr.trim()}`);
 assert.equal((await fetch(ready.origin + '/health')).status, 200, 'the first checkout stays live through refusal');
});
