import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from './commands.mjs';
import { waitForReadiness } from './readiness.mjs';

const forever = () => new Promise(() => {});
function fixture() {
 let closed, exited, failed;
 const child = { exitCode: null, signalCode: null };
 const capture = { closed: new Promise(r => { closed = r; }), exited: new Promise(r => { exited = r; }), failed: new Promise(r => { failed = r; }) };
 return { child, capture, closed, exited, failed };
}
const failure = (_label, detail) => Object.assign(new Error(detail.reason), detail);
function readiness(f, health, options = {}) {
 return waitForReadiness('Start', f.child, health, { timeoutMs: 1000, intervalMs: 5, probeTimeoutMs: 20, ...options }, f.capture, () => {}, failure);
}

test('hung HTTP request times out and a later healthy response retains the owned app', async t => {
 const root = await mkdtemp(join(tmpdir(), 'readiness-http-'));
 const store = await createCommands(root, { logs: [] }, { terminal: () => {} });
 let requests = 0;
 const sockets = new Set();
 const server = createServer((_req, res) => {
  if (++requests === 1) return;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
 });
 server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
 let child;
 t.after(async () => {
  await store.stop(child);
  await store.closeCommands();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = `http://127.0.0.1:${server.address().port}`;
 child = store.spawn('HTTP app lifetime', process.execPath, ['-e', 'setInterval(()=>{},1000)']);
 const signals = [];
 const result = await store.waitForReady('Start', child, async signal => {
  signals.push(signal);
  const response = await fetch(origin + '/health', { signal });
  return { ready: (await response.json()).status === 'ok' };
 }, { timeoutMs: 3000, intervalMs: 5, probeTimeoutMs: 100 });
 assert.equal(result.ready, true);
 assert.ok(requests >= 2, 'only one request consumed the startup deadline');
 assert.equal(signals[0].aborted, true);
 assert.notEqual(signals[0], signals[1]);
 assert.equal(child.exitCode, null);
 assert.equal(child.signalCode, null);
 assert.doesNotThrow(() => process.kill(child.pid, 0), 'healthy app was terminated');
});

test('a callback ignoring its abort signal cannot block later probes', async () => {
 const f = fixture();
 let attempts = 0, firstSignal;
 const result = await readiness(f, signal => {
  if (++attempts === 1) { firstSignal = signal; return forever(); }
  assert.equal(firstSignal.aborted, true);
  return true;
 });
 assert.equal(result, true);
 assert.equal(attempts, 2);
 assert.equal(f.child.exitCode, null);
});

for (const reason of ['cancel', 'deadline', 'exit', 'error']) test(`${reason} promptly aborts an active uncooperative probe`, async () => {
 const f = fixture(), controller = new AbortController();
 let begin;
 const entered = new Promise(resolve => { begin = resolve; });
 let probeSignal;
 const pending = readiness(f, signal => { probeSignal = signal; begin(); return forever(); }, {
  signal: controller.signal, timeoutMs: reason === 'deadline' ? 30 : 1000, probeTimeoutMs: 5000,
 });
 const rejected = assert.rejects(pending, error => reason === 'exit' ? error.reason === 'closed' && error.code === 40 : error.reason === reason);
 await entered;
 const start = Date.now();
 if (reason === 'cancel') controller.abort();
 if (reason === 'exit') {
  f.child.exitCode = 40;
  f.capture.exitResult = { code: 40 };
  f.exited({ code: 40 });
  f.closed({ code: 40 });
 }
 if (reason === 'error') f.failed({ code: 1 });
 await rejected;
 assert.equal(probeSignal.aborted, true);
 assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
 assert.ok(Date.now() - start < 500, 'outer event waited for the per-probe timeout');
});

test('probe, progress and deadline waits clean up with an injected clock', async () => {
 let now = 0;
 const timers = new Set();
 const wait = (ms, signal) => new Promise(resolve => {
  const entry = { at: now + ms, finish: () => { timers.delete(entry); signal.removeEventListener('abort', entry.finish); resolve(); } };
  timers.add(entry);
  signal.addEventListener('abort', entry.finish, { once: true });
  if (signal.aborted) entry.finish();
 });
 const advance = async ms => {
  now += ms;
  for (const timer of [...timers]) if (timer.at <= now) timer.finish();
  for (let i = 0; i < 30; i++) await Promise.resolve();
 };
 const f = fixture();
 let attempts = 0;
 const result = readiness(f, () => ++attempts === 1 ? forever() : true, { now: () => now, wait });
 await advance(0);
 await advance(20);
 await advance(5);
 assert.equal(await result, true);
 assert.equal(attempts, 2);
 assert.equal(timers.size, 0);
 for (const value of [0, -1, NaN, Infinity]) await assert.rejects(readiness(f, () => true, { probeTimeoutMs: value }), /positive/);
});

for (const [intervalMs, expected] of [[1, 5000], [2000, 6000]]) test(`default probe timeout follows interval ${intervalMs}`, async () => {
 const durations = [], pending = new Set();
 const wait = (ms, signal) => new Promise(resolve => {
  durations.push(ms);
  const done = () => { pending.delete(done); signal.removeEventListener('abort', done); resolve(); };
  pending.add(done);
  signal.addEventListener('abort', done, { once: true });
 });
 const f = fixture();
 assert.equal(await readiness(f, () => true, { wait, intervalMs, probeTimeoutMs: undefined, timeoutMs: 100000 }), true);
 assert.ok(durations.includes(expected));
 assert.equal(pending.size, 0);
});
