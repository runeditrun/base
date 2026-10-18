import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identity } from '../modules/job-queue/identity.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

const run = promisify(execFile);
const entry = join(import.meta.dirname, '../bin/rer.mjs');

test('bounded CLI queue timeouts refuse without starting and name the wait and retry in text and JSON', { timeout: 60000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-queue-timeout-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME,
  RER_JOBS_SLOTS: '2', RER_JOBS_MAX_WAIT_SECONDS: '1', RER_JOBS_POLL_MS: '20' });
 const verbs = ['build', 'deploy', 'install', 'setup', 'verify', 'export', 'import'];
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/queue-timeout',
  runtime: { requirements: [] }, requiredEnvironment: [], commands: Object.fromEntries(verbs.map(verb => [verb,
   { argv: [process.execPath, 'task.mjs'], inputs: ['task.mjs'], effects: 'Writes a marker when started.' }])) }));
 await writeFile(join(root, 'task.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('started','yes');\n");
 // Lifetime identities keep fake running members live without starting work.
 const owner = await identity();
 t.after(() => owner.close());
 const running = [1, 2].map(sequence => ({ id: `held-${sequence}`, sequence, priority: 'normal',
  label: `Held slot ${sequence}`, repository: root, enqueuedAt: Date.now(), startedAt: Date.now(), owner: owner.info }));
 const statePath = join(env.RER_JOBS_DIR, 'state.json');
 await writeFile(statePath, JSON.stringify({ version: 1, sequence: running.length, queued: [], running }));
 for (const verb of verbs) for (const json of [false, true]) {
  const result = await run(process.execPath, [entry, verb, ...(json ? ['--json'] : [])],
   { cwd: root, env, timeout: 10000 }).catch(error => error);
  assert.equal(result.code, 75, result.stdout + result.stderr);
  const events = json ? result.stdout.trim().split('\n').map(JSON.parse) : [];
  const error = events.find(event => event.event === 'error');
  const message = json ? error?.message : result.stderr;
  assert.match(message, /Not started:/);
  assert.match(message, /did not admit.*within \d+ seconds/);
  assert.match(message, /all job slots are in use/);
  assert.ok(message.includes(`running rer ${verb} again`), message);
  assert.doesNotMatch(result.stdout + result.stderr, /Bounded command ended/);
  if (json) {
   assert.equal(error.code, 'safety_refusal');
   assert.equal(error.exitCode, 75);
   assert.deepEqual(events.filter(event => event.event === 'result'),
    [{ version: 1, verb, event: 'result', ok: false, exitCode: 75 }]);
  }
  await assert.rejects(access(join(root, 'started')), { code: 'ENOENT' });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(state.queued, []);
  assert.deepEqual(state.running, running);
 }
});
