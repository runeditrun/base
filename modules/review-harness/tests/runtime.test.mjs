import { namedSteps } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../index.mjs';
import { liveOwnedGroup } from '../process-group.mjs';
import { root, temporary, fixture } from './helpers.mjs';

async function options(t, mode, extra = {}) {
  const directory = await temporary(t, 'review-runtime-');
  return { cwd: root, command: process.execPath, args: [new URL('./process-fixture.mjs', import.meta.url).pathname, mode, '{PORT}'], logDir: directory, readyTimeoutMs: 3000, stopTimeoutMs: 150, ...extra };
}
function fallbackCleanup(t, runtime) {
  t.after(() => { try { process.kill(-runtime.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
}
async function refused(t, config) {
  let runtime, error;
  try { runtime = await startRuntime(config); } catch (value) { error = value; }
  if (runtime) { fallbackCleanup(t, runtime); await runtime.stop(); }
  assert.ok(error, 'start must reject');
  return error;
}

test('concurrent runtimes own distinct listeners while slow health becomes ready inside the bound', async t => {
  const started = performance.now();
  const configs = await Promise.all([options(t, 'slow'), options(t, 'environment')]);
  const [runtime, other] = await Promise.all(configs.map(async config => {
    const launched = await startRuntime(config);
    fallbackCleanup(t, launched);
    t.after(() => launched.stop());
    return launched;
  }));
  try {
    assert.equal(new URL(runtime.origin).hostname, '127.0.0.1');
    assert.notEqual(runtime.port, other.port);
    assert.ok(performance.now() - started >= 300);
    assert.equal((await fetch(runtime.origin + '/health')).status, 200);
    assert.equal((await fetch(other.origin + '/environment')).status, 200);
    await runtime.stop();
    assert.equal((await fetch(other.origin + '/health')).status, 200);
  } finally { await Promise.all([runtime.stop(), other.stop()]); }
});
test("runtime start refuses exit, timeout, exposure and fixture failure with private diagnostics", async t => {
  const step = namedSteps(t);
  await step('exit before readiness fails with the private log path', async t => {
    const error = await refused(t, await options(t, 'exit'));
    assert.match(error.message, /exited before ready.*private log:/);
  });
  
  await step('health timeout is bounded and cleans up its process', async t => {
    const started = performance.now();
    const error = await refused(t, await options(t, 'timeout', { readyTimeoutMs: 300 }));
    assert.match(error.message, /health timed out.*private log:/);
    assert.ok(performance.now() - started < 4000);
  });
  
  await step('spawn errors fail promptly with diagnostics', async t => {
    const error = await refused(t, await options(t, 'exit', { command: '/nonexistent-review-command' }));
    assert.match(error.message, /exited before ready.*private log:/);
  });
  
  await step('launcher refuses a command that exposes its port outside loopback', async t => {
    const error = await refused(t, await options(t, 'wide'));
    assert.match(error.message, /listener is exposed outside 127\.0\.0\.1.*private log:/);
  });
  
  await step('fixture failure tears down the healthy process and redacts its diagnostic', async t => {
    const error = await refused(t, await options(t, 'environment', { secrets: ['synthetic-fixture-secret'], fixtures: async () => { throw new Error('synthetic-fixture-secret'); } }));
    assert.equal(error.message.includes('synthetic-fixture-secret'), false);
    assert.match(error.message, /private log:/);
  });
})



test('logs redact chunked secrets and token queries; files and temporary storage are private', async t => {
  const mask = process.umask(0);
  t.after(() => process.umask(mask));
  const secret = 'synthetic-runtime-credential';
  const runtime = await startRuntime(await options(t, 'log', { secrets: [secret] }));
  fallbackCleanup(t, runtime);
  const environment = await (await fetch(runtime.origin + '/environment')).json();
  await delay(50);
  await runtime.stop();
  const log = await readFile(runtime.logPath, 'utf8');
  for (const forbidden of [secret, 'synthetic-query-credential', 'synthetic-last-query']) assert.equal(log.includes(forbidden), false);
  assert.match(log, /\[redacted\]/);
  assert.equal((await stat(runtime.logPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(runtime.logPath, '..'))).mode & 0o777, 0o700);
  await assert.rejects(access(environment.env.TMPDIR));
});
test('environment is minimal, extras explicit, isolation flags enforced and listener origin reported', async t => {
  process.env.REVIEW_UNDECLARED = 'must-not-inherit';
  const runtime = await startRuntime(await options(t, 'environment', { env: { REVIEW_EXPLICIT: 'supplied', WRANGLER_SEND_METRICS: 'true' } }));
  fallbackCleanup(t, runtime);
  try {
    const data = await (await fetch(runtime.origin + '/environment')).json();
    assert.equal(data.origin, runtime.origin);
    assert.equal(data.env.REVIEW_UNDECLARED, undefined);
    assert.equal(data.env.REVIEW_EXPLICIT, 'supplied');
    for (const name of ['WRANGLER_SEND_METRICS', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV']) assert.equal(data.env[name], 'false');
    assert.equal((await stat(data.env.TMPDIR)).mode & 0o777, 0o700);
  } finally { delete process.env.REVIEW_UNDECLARED; await runtime.stop(); }
});
test('listener is IPv4 loopback only', async t => {
  const runtime = await startRuntime(await options(t, 'environment'));
  fallbackCleanup(t, runtime);
  try {
    const { networkInterfaces } = await import('node:os');
    const address = Object.values(networkInterfaces()).flat().find(info => info.family === 'IPv4' && !info.internal)?.address;
    assert.ok(address, 'container has a non-loopback address for the bind check');
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: address, port: runtime.port });
      socket.once('error', () => resolve());
      socket.once('connect', () => { socket.destroy(); reject(new Error('listener exposed outside loopback')); });
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('bind check timed out')); });
    });
  } finally { await runtime.stop(); }
});
test("runtime stop sends TERM then confirms resistant descendants disappear within its budget", async t => {
  const step = namedSteps(t);
  await step('TERM, bounded KILL and group inspection remove a resistant grandchild', async t => {
    const runtime = await startRuntime(await options(t, 'tree'));
    fallbackCleanup(t, runtime);
    let log = '';
    for (let attempt = 0; attempt < 50 && !log.includes('grandchild'); attempt++) { await delay(20); log = await readFile(runtime.logPath, 'utf8'); }
    const pid = JSON.parse(log.split('\n').find(line => line.startsWith('{'))).grandchild;
    assert.ok(pid > 0);
    const started = performance.now();
    await runtime.stop();
    await runtime.stop();
    assert.ok(performance.now() - started < 4000);
    assert.equal(await liveOwnedGroup(runtime.pid, 1000), false);
    const states = execFileSync('ps', ['-Ao', 'pid=,stat=']).toString();
    const remaining = states.split('\n').find(line => Number(line.trim().split(/\s+/)[0]) === pid);
    assert.ok(!remaining || remaining.trim().split(/\s+/)[1].startsWith('Z'));
  });
  
  await step('stop sends TERM before escalating', async t => {
    const runtime = await startRuntime(await options(t, 'term'));
    fallbackCleanup(t, runtime);
    await runtime.stop();
    assert.match(await readFile(runtime.logPath, 'utf8'), /received TERM/);
  });
  
  await step('a tiny graceful inspection budget still confirms group disappearance after KILL', async t => {
    const runtime = await startRuntime(await options(t, 'tree', { stopTimeoutMs: 1 }));
    fallbackCleanup(t, runtime);
    await runtime.stop();
    assert.equal(await liveOwnedGroup(runtime.pid, 1000), false);
  });
  
  await step('slow process inspection uses the remaining shutdown budget', async t => {
    const runtime = await startRuntime(await options(t, 'tree'));
    fallbackCleanup(t, runtime);
    let log = '';
    for (let attempt = 0; attempt < 50 && !log.includes('grandchild'); attempt++) { await delay(20); log = await readFile(runtime.logPath, 'utf8'); }
    assert.ok(JSON.parse(log.split('\n').find(line => line.startsWith('{'))).grandchild > 0);
    const directory = await temporary(t, 'review-slow-inspector-');
    // An inspector can exit zero after its deadline signal, with an incomplete
    // snapshot. That is not proof that the resistant child has disappeared.
    await writeFile(join(directory, 'ps'), `#!${process.execPath}\nimport { execFileSync } from 'node:child_process';\nprocess.on('SIGTERM', () => process.exit(0));\nsetTimeout(() => { process.stdout.write(execFileSync('/bin/ps', process.argv.slice(2))); }, 1500);\n`, { mode: 0o700 });
    const previous = process.env.PATH;
    process.env.PATH = `${directory}:${previous}`;
    try { await runtime.stop(); }
    finally { process.env.PATH = previous; }
    assert.equal(await liveOwnedGroup(runtime.pid, 5000), false);
  });
})





test('synthetic fixtures finish before readiness resolves', async t => {
  let finished = false;
  const runtime = await fixture(t, { args: ['--health-delay', '500'], fixtures: async origin => {
    assert.equal((await fetch(origin + '/__fixtures/setup', { method: 'POST' })).status, 200);
    await delay(100); finished = true;
  } });
  assert.equal(finished, true);
  assert.equal((await fetch(runtime.origin + '/health')).status, 200);
});

