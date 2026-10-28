import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { deliverGroupSignal, processInfo, stopGroup } from '../processes.mjs';
import { setup, until, client, worker, noLivePids, cli } from './helpers.mjs';
import { recordedState } from './state.mjs';

test("queued CLI execution preserves command results and releases custody after exit, cancellation or supervisor loss", async t => {
  const step = namedSteps(t);
  await step('CLI passes command exit, exact argv, stdout and low priority; JSON status and drain', async t => {
    const { directory } = await setup(t);
    const result = await client(t, directory, ['run', '--kind', 'heavy', '--json', '--', process.execPath,
      '-e', 'console.log(process.argv[1]);process.exit(27)', 'literal $() with spaces']).done;
    assert.equal(result.code, 27); assert.equal(result.stdout.trim(), 'literal $() with spaces');
    assert.equal(JSON.parse(result.stderr.trim()).code, 27);
    const status = await client(t, directory, ['status', '--json']).done;
    assert.equal(JSON.parse(status.stdout).running.length, 0);
    assert.equal((await client(t, directory, ['drain', '--json', '--max-wait', '1']).done).code, 0);
    const niceFile = join(directory, 'nice');
    assert.equal((await client(t, directory, ['run', '--kind', 'heavy', '--', process.execPath, worker, 'nice', niceFile]).done).code, 0);
    assert.ok(Number(await readFile(niceFile, 'utf8')) >= 15);
  });

  await step('CLI max-wait uses a distinct code and clear reason without starting command', async t => {
    const { directory } = await setup(t);
    const result = await client(t, directory, ['run', '--kind', 'heavy', '--max-wait', '.1', '--', process.execPath,
      '-e', 'console.log("MUST NOT START")'], { env: { RER_JOBS_LOAD_THRESHOLD: '0' } }).done;
    assert.equal(result.code, 75); assert.match(result.stderr, /max-wait expired.*load/);
    assert.equal(result.stdout, '');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) await step(`${signal} stops an ignoring command and grandchild and releases slot`, async t => {
    const { directory } = await setup(t);
    const ledger = recordedState(directory);
    const file = join(directory, 'pids');
    const release = join(directory, 'release-successor');
    const job = client(t, directory, ['run', '--kind', 'heavy', '--label', signal, '--', process.execPath, worker, 'tree', file]);
    let successor;
    try {
      const pids = await until(async () => JSON.parse(await readFile(file, 'utf8').catch(() => 'null')));
      const held = await ledger.wait(state => state.running.some(job => job.label === signal && job.owner.pgid));
      const lease = held.running[0];
      successor = client(t, directory, ['run', '--kind', 'heavy', '--label', 'successor', '--', process.execPath, worker, 'gate', release]);
      const waiting = await ledger.wait(state => state.queued.some(job => job.label === 'successor'));
      assert.deepEqual(waiting.running.map(job => job.id), [lease.id]);
      job.child.kill(signal);
      const result = await job.done;
      assert.equal(result.code, signal === 'SIGINT' ? 130 : 143);
      const granted = await ledger.wait(state => state.running.some(job => job.label === 'successor'));
      assert.deepEqual(granted.running.map(job => job.id), [waiting.queued[0].id]);
      assert.deepEqual(granted.queued, []);
      assert.ok(await noLivePids([lease.owner.pid, ...pids]),
        'The old supervisor, command and grandchild must be stopped when the next lease is granted');
      await writeFile(release, 'go');
      assert.equal((await successor.done).code, 0);
      assert.deepEqual((await ledger.read()).running, []);
    } finally {
      if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM');
      await writeFile(release, 'go');
      await Promise.allSettled([job.done, successor?.done]);
    }
  });

  await step('ordinary exit cleans surviving background descendants', async t => {
    const { directory } = await setup(t);
    const file = join(directory, 'leftover');
    const result = await client(t, directory, ['run', '--kind', 'heavy', '--', process.execPath, worker, 'leftover', file]).done;
    assert.equal(result.code, 0);
    const pids = JSON.parse(await readFile(file, 'utf8'));
    await until(() => noLivePids(pids));
    assert.deepEqual((await recordedState(directory).read()).running, []);
  });

  for (const target of ['caller', 'supervisor']) await step(`SIGKILL of ${target} leaves no live descendants after reclaim`, async t => {
    const { directory, queue } = await setup(t);
    const ledger = recordedState(directory);
    const file = join(directory, 'crash-pids');
    const job = client(t, directory, ['run', '--kind', 'heavy', '--', process.execPath, worker, 'tree', file]);
    const pids = await until(async () => JSON.parse(await readFile(file, 'utf8').catch(() => 'null')));
    const held = await ledger.wait(state => state.running.length === 1 && state.running[0].owner.pgid);
    const lease = held.running[0];
    if (target === 'caller') job.child.kill('SIGKILL');
    else {
      process.kill(lease.owner.pid, 'SIGKILL');
    }
    await job.done;
    await until(async () => (await queue.status()).running.length === 0);
    assert.deepEqual((await ledger.read()).running, []);
    await until(() => noLivePids([lease.owner.pid, ...pids]));
  });

  await step('failure to spawn executable passes 127 and releases slot', async t => {
    const { directory } = await setup(t);
    const result = await client(t, directory, ['run', '--kind', 'heavy', '--', '/no/such/rer-command']).done;
    assert.equal(result.code, 127); assert.deepEqual((await recordedState(directory).read()).running, []);
  });

  await step('command self-termination preserves its signal exit status', async t => {
    const { directory } = await setup(t);
    const result = await client(t, directory, ['run', '--kind', 'heavy', '--', process.execPath,
      '-e', 'process.kill(process.pid,"SIGTERM")']).done;
    assert.equal(result.code, 143);
  });

  await step('CLI invoked through a symlink executes the requested command', async t => {
    const { directory } = await setup(t);
    const linked = join(directory, 'linked-cli.mjs'); await symlink(cli, linked);
    const result = await client(t, directory, ['run', '--kind', 'heavy', '--', process.execPath,
      '-e', 'process.exit(29)'], { entrypoint: linked }).done;
    assert.equal(result.code, 29);
  });

  await step('a queued command survives probes that close its identity socket mid-write', async t => {
    const { directory } = await setup(t);
    const ledger = recordedState(directory);
    const release = join(directory, 'release');
    const job = client(t, directory, ['run', '--kind', 'heavy', '--label', 'peer-close', '--', process.execPath, worker, 'gate', release]);
    const { running: [lease] } = await ledger.wait(state => state.running.length === 1);
    for (let i = 0; i < 200; i++) {
      const peer = createConnection(lease.owner.socket);
      peer.on('error', () => {});
      peer.on('connect', () => peer.destroy());
      await new Promise(resolve => peer.once('close', resolve));
    }
    await writeFile(release, '');
    const result = await job.done;
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /EPIPE|ECONNRESET/);
  });
})
















test("group signal permission refusal completes only after independent disappearance proof", async t => {
  const step = namedSteps(t);
  await step('denied group signal means completion only with proof that no live member remains', async () => {
    const send = () => { throw Object.assign(Error('Denied'), { code: 'EPERM' }); };
    assert.equal(await deliverGroupSignal(123, 'SIGTERM', { send, live: async () => false }), false);
  });

  await step('denied signal remains an error for live members or an unavailable group probe', async () => {
    const send = () => { throw Object.assign(Error('Denied'), { code: 'EPERM' }); };
    await assert.rejects(deliverGroupSignal(123, 'SIGKILL', { send, live: async () => true }), { code: 'EPERM' });
    await assert.rejects(deliverGroupSignal(123, 'SIGKILL', { send, live: async () => { throw Error('Probe unavailable'); } }), /unavailable/);
  });
})




test('real zombie-only process group completes cleanup on macOS and Linux', async t => {
  const { directory } = await setup(t);
  const file = join(directory, 'zombie-pid');
  const child = spawn(process.execPath, [worker, 'zombie', file], { stdio: 'ignore' });
  const done = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; });
  const [pid] = await until(async () => JSON.parse(await readFile(file, 'utf8').catch(() => 'null')));
  await until(async () => (await processInfo(pid))?.zombie);
  let denied = false;
  try { process.kill(-pid, 0); } catch (error) { denied = error.code === 'EPERM'; }
  const result = await deliverGroupSignal(pid, 'SIGKILL');
  if (denied) assert.equal(result, false);
  assert.ok(await noLivePids([pid]));
  child.kill('SIGKILL'); await done;
});

test('a replacement group with the same start stamp but a different supervisor title survives', async t => {
  const child = spawn(process.execPath, ['-e',
    'process.title="rer-replacement-fixture";console.log("ready");setInterval(()=>{},1000)'],
  { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    await done;
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('close', () => reject(Error('Replacement exited before readiness')));
  });
  const owner = await processInfo(child.pid);
  await stopGroup({ ...owner, pgid: child.pid, marker: 'rer-prior-supervisor' }, 30);
  const current = await processInfo(child.pid);
  assert.ok(current && !current.zombie, 'Recycled process-group identity must not authorize a signal');
});



test('a managed store still stops a queued supervisor that retitles itself after launch', async t => {
  const { directory } = await setup(t);
  const { createCommands } = await import('../../../onboarding/commands.mjs');
  const store = await createCommands(directory, { logs: [] }, { terminal: () => {} });
  // Like supervisor.mjs: it retitles itself after launch and never exits on its own.
  const child = store.spawn('retitling supervisor', process.execPath, ['-e',
    'process.stdin.once("data",()=>{process.title="rer-job-supervisor-fixture";console.log("retitled")});setInterval(()=>{},1000)'],
  { stdio: ['pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await store.closeCommands();
  });
  // The store captures custody at launch; retitle only after that capture.
  await delay(1000);
  const retitled = new Promise(resolve => child.stdout.once('data', resolve));
  child.stdin.write('go\n'); await retitled;
  assert.match((await processInfo(child.pid)).title, /^rer-job-supervisor-fixture/);
  await store.stop(child);
  assert.equal(await exited, 'SIGTERM');
});
