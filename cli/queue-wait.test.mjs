import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './fixtures/reference.mjs';

function startInstall(root, queueDirectory, json, secret) {
  const child = spawn(process.execPath,
    [join(root, 'scripts/rer.mjs'), 'install', ...(json ? ['--json'] : [])], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? tmpdir(),
        PWD: root,
        CONNECTION_PASSWORD: secret,
        RER_JOBS_DIR: queueDirectory,
        RER_JOBS_SLOTS: '1',
        RER_JOBS_LOAD_THRESHOLD: '999999',
        RER_JOBS_MIN_FREE_MEMORY_BYTES: '8000000000000000',
        RER_JOBS_POLL_MS: '3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let stdout = '', stderr = '', stdoutBuffer = '', textReportCount = 0;
  const events = [];
  const textReportsAt = [];
  child.stdout.on('data', chunk => {
    stdout += chunk;
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try { events.push({ ...JSON.parse(line), observedAt: Date.now() }); } catch {}
    }
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    const count = stderr.split('Inspect the queue with:').length - 1;
    while (textReportCount < count) { textReportsAt.push(Date.now()); textReportCount++; }
  });
  const done = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  const waiting = () => events.filter(event => event.event === 'waiting');
  async function until(probe, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = probe();
      if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`rer exited before reporting a queue wait; stdout: ${stdout}; stderr: ${stderr}`);
      await delay(25);
    }
    throw Error(`rer did not report a queue wait within ${timeoutMs} ms: ${stderr}`);
  }
  return { child, done, events, textReportsAt, waiting, until, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function assertDisplayedStatus(command, root, queueDirectory, queued) {
  assert.ok(!command.includes('[REDACTED]'), 'the displayed queue command must remain usable after redaction');
  const status = spawnSync(command, {
    shell: true, cwd: root, encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(),
      RER_JOBS_DIR: queueDirectory,
    },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).queued.length, queued,
    'the displayed shell command must inspect this live queue from the project root');
}

function assertWaitDetails(wait, root, queueDirectory, position, queued) {
  assert.equal(wait.position, position);
  assert.equal(wait.queued, queued);
  assert.equal(wait.running, 0);
  assert.ok(Number.isFinite(wait.resources.load));
  assert.ok(Number.isFinite(wait.resources.availableMemoryBytes));
  assert.ok(Number.isFinite(wait.limits.minFreeMemoryBytes));
  assert.ok(wait.resources.availableMemoryBytes <= wait.limits.minFreeMemoryBytes);
  assert.ok(wait.reason.includes('RER_JOBS_MIN_FREE_MEMORY_BYTES'));
  assert.equal(wait.statusCommand[0], process.execPath);
  assert.deepEqual(wait.statusCommand.slice(2), ['status', '--json']);
  assertDisplayedStatus(wait.statusCommandText, root, queueDirectory, queued);
  const status = spawnSync(wait.statusCommand[0], wait.statusCommand.slice(1), {
    cwd: root, encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir(),
      RER_JOBS_DIR: queueDirectory,
    },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).queued.length, queued, 'the reported status command must inspect this live queue');
}

test('exported default-seed and foundation report real queue waits in text and NDJSON', async t => {
  const defaultSeed = await fixture('default-seed', t);
  const foundation = await fixture('foundation', t);
  const queueDirectory = await mkdtemp(join(tmpdir(), 'rer queue wait state '));
  const secret = randomUUID();
  t.after(() => rm(queueDirectory, { recursive: true, force: true }));
  let textRun, jsonRun;
  try {
    textRun = startInstall(defaultSeed.root, queueDirectory, false, secret);
    await textRun.until(() => textRun.textReportsAt[0]);
    assert.match(textRun.stderr, /queue position 1\/1/);
    assert.match(textRun.stderr, /Memory: [0-9.]+ GiB available, floor [0-9.]+ GiB\. Change the floor with RER_JOBS_MIN_FREE_MEMORY_BYTES/);
    const quote = process.platform === 'win32' ? '"' : "'";
    assert.ok(textRun.stderr.includes(`${quote}status${quote} ${quote}--json${quote}`));
    const displayed = /Inspect the queue with: (.+)/.exec(textRun.stderr)?.[1];
    assert.ok(displayed, 'human waits must provide a queue command');
    assertDisplayedStatus(displayed, defaultSeed.root, queueDirectory, 1);
    assert.match(textRun.stderr, /[Ff]rom the project root/);
    assert.ok(!textRun.stderr.includes(defaultSeed.root), 'the credential-classified PWD must not leak');

    jsonRun = startInstall(foundation.root, queueDirectory, true, secret);
    const first = await jsonRun.until(() => jsonRun.waiting()[0]);
    assert.equal(first.verb, 'install');
    assert.equal(first.event, 'waiting');
    assertWaitDetails(first, foundation.root, queueDirectory, 2, 2);
    assert.deepEqual(first.reasonCodes, ['queue_order', 'free_memory']);

    await textRun.until(() => textRun.textReportsAt[1]);
    const periodic = await jsonRun.until(() => jsonRun.waiting()[1]);
    assert.equal(periodic.position, 2);

    const cancelledAt = Date.now();
    textRun.child.kill('SIGINT');
    const textExit = await textRun.done;
    assert.equal(textExit.code, 130);

    const shifted = await jsonRun.until(() => jsonRun.waiting().find(wait => wait.position === 1));
    assert.ok(shifted.observedAt > cancelledAt);
    assert.ok(shifted.observedAt - periodic.observedAt < periodic.observedAt - first.observedAt,
      'a position change should report before the next normal refresh');
    assertWaitDetails(shifted, foundation.root, queueDirectory, 1, 1);
    assert.deepEqual(shifted.reasonCodes, ['free_memory']);

    jsonRun.child.kill('SIGINT');
    assert.equal((await jsonRun.done).code, 130);

    const lines = jsonRun.stdout.trim().split('\n');
    assert.ok(lines.length > 0);
    assert.doesNotThrow(() => lines.forEach(line => JSON.parse(line)), 'JSON stdout must contain NDJSON events only');
    assert.equal(jsonRun.events.filter(event => event.event === 'result').length, 1);
    for (const run of [textRun, jsonRun]) {
      assert.ok(!(run.stdout + run.stderr).includes(secret), 'the supplied credential must not leak');
    }

  } finally {
    for (const run of [textRun, jsonRun]) {
      if (run && run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGINT');
    }
    await Promise.all([textRun?.done, jsonRun?.done].filter(Boolean));
  }
});
