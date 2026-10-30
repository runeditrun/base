import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fixtureSeed } from './tests/fixtures/agent-door/seed.mjs';
import { document } from './tests/fixtures/agent-door/bridge-seed.mjs';
import { exportCLI } from './export.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { serveHosted } from './hosted-output.mjs';
import { testSource } from '../composition/git-source.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('built public CLI fixtures fail only declared queue producers before enqueue and restore normal sends', { timeout: 180000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 await document(root, 'dist/server/wrangler.json', config => {
  config.queues = { producers: ['JOBS', 'OTHER'].map(binding => ({ binding, queue: 'fixture-jobs' })),
   consumers: [{ queue: 'fixture-jobs', max_batch_size: 1, max_batch_timeout: 0, max_retries: 0 }] };
 });
 await writeFile(join(root, 'dist/server/migrations/0099_queue.sql'), 'CREATE TABLE fixture_queue_deliveries(id TEXT PRIMARY KEY);');
 for (const file of ['queue-producer.mjs', 'queue-faults.mjs']) await cp(join(import.meta.dirname, 'tests/fixtures/agent-door', file), join(root, file));
 await writeFile(join(root, 'build-fixture.mjs'), `
import { buildFixture } from ${JSON.stringify(new URL('./tests/fixtures/agent-door/seed.mjs', import.meta.url).href)};
import { rename, cp } from 'node:fs/promises';
await buildFixture(process.cwd());
await rename('dist/server/index.js', 'dist/server/native.mjs');
await cp('queue-producer.mjs', 'dist/server/index.js');
`);
 await document(root, 'agent-surface.json', surface => { surface.verification.fixtures = { module: 'queue-faults.mjs' }; });
 await exportCLI(base, root);
 await cp(join(base, 'onboarding'), join(root, 'scripts/base-onboarding'), { recursive: true,
  filter: path => !testSource(relative(join(base, 'onboarding'), path)),
 });
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 const { stdout, stderr } = await run(process.execPath, [join(root, 'scripts/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).catch(error => {
  assert.fail(JSON.stringify({ code: error.code, failures: error.stderr?.split('\n').filter(line => /^(FAIL |Agent door conformance:)/.test(line)), events: error.stdout?.split('\n').filter(line => line.includes('"error"')) }));
 });
 const result = stdout.trim().split('\n').map(JSON.parse).findLast(row => row.agentDoor);
 assert.equal(result?.agentDoor.ok, true, stderr + stdout);
 assert.doesNotMatch(stdout + stderr, /operator_session=|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
 t.diagnostic(`Built rer verify: ${result.agentDoor.points.filter(point => point.ok).length}/${result.agentDoor.points.length} conformance points; held sends 200, injected send/sendBatch 503 failed-JOBS, seven successful messages and zero failed messages consumed, restored sends 200, undeclared binding refused, phase reset passed.`);

 // Named Worker entrypoints also receive the controlled producer, without
 // relying on a fetch-handler env wrapper. A fresh host has no stale faults.
 const hosted = await serveHosted(root, { fixturePreparation: true, workerEntrypoints: ['QueueProbe'] });
 try {
  const { queues } = await hosted.preparation(), worker = await hosted.worker('QueueProbe');
  queues.hold();
  assert.equal((await worker.send({ id: 'rpc-normal' })).status, 200);
  await queues.fail('JOBS');
  for (const batch of [false, true]) {
   const result = await worker.send({ id: 'rpc-rejected', batch });
   assert.equal(result.status, 503);
   assert.equal(result.outcome, 'failed-JOBS');
  }
  await queues.restore('JOBS');
  assert.equal((await worker.send({ id: 'rpc-restored', batch: true })).status, 200);
 } finally { await hosted.close(); }
 const ordinary = await serveHosted(root);
 try {
  await assert.rejects(() => ordinary.preparation(), { code: 'hosted_database_invalid' });
  for (const batch of [false, true]) {
   const response = await ordinary.fetch('fixture/queue', { method: 'POST', body: JSON.stringify({ id: 'ordinary-' + batch, batch }) });
   assert.equal(response.status, 200);
   await response.body?.cancel();
  }
 } finally { await ordinary.close(); }
 assert.doesNotMatch(await readFile(join(root, 'dist/server/index.js'), 'utf8'), /RER_PREPARATION|Conformance queue producer failure/);
});
