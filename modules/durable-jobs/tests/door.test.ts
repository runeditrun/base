import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input, sales, expectedKeys, expectedCents, installationId } from './fixture.ts';

// Two maintained journeys cover the public flows. Additional hostile probes are
// one-off execution evidence in REPORT.md, rather than one permanent test per case.
test('durable job door retains idempotent sales intent, unit receipts and exact results across native storage restart', async t => {
  const f = await fixture(t); await f.populate();
  let jobs = f.jobs(); await jobs.start({ holder: 'native-door-process' });
  const created = await Promise.all([f.call('', input('october-us')), f.call('', input('october-us'))]);
  assert.deepEqual(created.map(r => r.status).sort(), [200, 202]);
  const id = created[0].body.job.id;
  assert.equal(created[1].body.job.id, id);
  assert.equal((await f.call('', { ...input('october-us'), requestedRevision: { sourceRevision: 'changed-content' } })).status, 409);
  const before = await jobs.claim({ id, holder: 'lost-before-commit' }); assert.ok(before);
  const prepared = await f.kind().runUnit(before, { database: f.database(), signal: new AbortController().signal, limits: { maxRowsPerUnit: 100 } as any }); assert.equal(prepared.type, 'commit');
  // A stopped process never publishes its prepared page. An explicit shutdown
  // fences that holder, and restart uses the persisted intent and checkpoint.
  await jobs.quiesce({ holder: 'native-door-process' }); await f.restart(); jobs = f.jobs(); await jobs.start({ holder: 'native-restarted' });
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM reference_sales_published_rows WHERE job_id=?').bind(id).first()).n, 0);
  await assert.rejects(() => jobs.commitUnit(before, prepared as any), { code: 'job_lease_stale' });
  const consumers = await Promise.all([jobs.claim({ id, holder: 'consumer-a' }), jobs.claim({ id, holder: 'consumer-b' })]);
  assert.equal(consumers.filter(Boolean).length, 1);
  const claim = consumers.find(Boolean)!;
  const unit = await f.kind().runUnit(claim, { database: f.database(), signal: new AbortController().signal, limits: { maxRowsPerUnit: 100 } as any }); assert.equal(unit.type, 'commit');
  await jobs.commitUnit(claim, unit as any); // Drop the response, then restart.
  await f.restart(); jobs = f.jobs();
  await jobs.commitUnit(claim, unit as any); // Saved receipt; no second write.
  for (let step = 0; step < 30; step++) {
    const state = await f.call('/' + id); if (state.body.job.state === 'succeeded') break;
    await jobs.tick({ maxJobs: 2, deadline: Date.now() + 10000 });
  }
  const done = await f.call('/' + id);
  assert.equal(done.body.job.state, 'succeeded', JSON.stringify(done.body));
  assert.deepEqual(done.body.job.resultRef, { sourceId: 'us-retail', sourceRevision: 'october-close', rows: sales.length, totalMinor: expectedCents, currency: 'USD' });
  const rows = (await f.db.prepare('SELECT sale_id,amount_minor FROM reference_sales_published_rows WHERE job_id=? ORDER BY sale_id').bind(id).all()).results;
  assert.deepEqual(rows.map(row => row.sale_id), expectedKeys);
  assert.equal(rows.reduce((sum, row) => sum + row.amount_minor, 0), expectedCents);
  const snapshot = JSON.stringify(rows);
  await f.restart(); jobs = f.jobs();
  const repeated = await f.call('', input('october-us'));
  assert.equal(repeated.status, 200); assert.deepEqual(repeated.body.job.resultRef, done.body.job.resultRef);
  const resumed = await f.call('/' + id + '/resume', { expectedVersion: done.body.job.version, operationKey: 'read-completed' });
  assert.equal(resumed.body.job.state, 'succeeded');
  await jobs.tick({ maxJobs: 2, deadline: Date.now() + 10000 });
  assert.equal(JSON.stringify((await f.db.prepare('SELECT sale_id,amount_minor FROM reference_sales_published_rows WHERE job_id=? ORDER BY sale_id').bind(id).all()).results), snapshot);
  const inspected = await f.cli(['inspect', id]); assert.deepEqual(inspected.job, repeated.body.job);
  const status = await f.cli(['status']); assert.equal(status.status.counts.succeeded, 1);
  assert.equal((await f.call('/' + id + '/undo', { expectedVersion: done.body.job.version, operationKey: 'no-generic-inverse' })).body.error.code, 'undo_unsupported');
  await f.populate(null, sales.slice(0, 100), 'restated-close');
  const saved = await f.db.prepare('SELECT version,operations_json,checkpoint,result_ref FROM rer_job_jobs WHERE id=?').bind(id).first();
  for (const operationKey of ['read-completed', 'read-completed', 'another-terminal-read']) {
    const terminal = await f.call('/' + id + '/resume', { expectedVersion: done.body.job.version, operationKey });
    assert.equal(terminal.status, 200); assert.deepEqual(terminal.body.job.resultRef, done.body.job.resultRef);
  }
  assert.deepEqual(await f.db.prepare('SELECT version,operations_json,checkpoint,result_ref FROM rer_job_jobs WHERE id=?').bind(id).first(), saved);
  assert.equal((await f.call('/' + id + '/resume', { expectedVersion: done.body.job.version, operationKey: 'read-completed', reason: 'changed content' })).body.error.code, 'job_operation_conflict');
});

test('job authority, cancellation and admission boundaries refuse stale publication and expose scoped holds without spending attempts', async t => {
  const f = await fixture(t); await f.populate(null, sales.slice(0, 150));
  const jobs = f.jobs({ installationConcurrency: 1 }); await jobs.start({ holder: 'boundary-process' });
  const a = await f.authority();
  const first = (await f.call('', input('first'))).body.job;
  const queued = (await f.call('', input('queued-cancel'))).body.job;
  const cancelled = await f.call('/' + queued.id + '/cancel', { expectedVersion: queued.version, operationKey: 'cancel-queued' }); assert.equal(cancelled.body.job.state, 'cancelled');
  assert.equal(await jobs.claim({ id: queued.id }), null);
  const active = await jobs.claim({ id: first.id }); assert.ok(active);
  const held = (await f.call('', input('capacity-held'))).body.job;
  for (let wake = 0; wake < 3; wake++) assert.equal(await jobs.claim({ id: held.id }), null);
  const capacity = (await f.call('/' + held.id)).body.job;
  assert.deepEqual([capacity.state, capacity.reasonCode, capacity.starts, capacity.failures], ['waiting','job_capacity_exhausted',0,0]);
  const matching = await f.cli(['inspect', held.id]); assert.deepEqual(matching.job, capacity);
  const runningCancel = await f.call('/' + first.id + '/cancel', { expectedVersion: active.job.version, operationKey: 'cancel-running' }); assert.equal(runningCancel.body.job.state, 'cancelled');
  const stale = await f.kind().runUnit(active, { database: f.database(), signal: new AbortController().signal, limits: { maxRowsPerUnit: 100 } as any });
  await assert.rejects(() => jobs.commitUnit(active, stale as any), { code: 'job_lease_stale' });
  const released = await jobs.claim({ id: held.id }); assert.ok(released);
  const prepared = await f.kind().runUnit(released, { database: f.database(), signal: new AbortController().signal, limits: { maxRowsPerUnit: 100 } as any });
  // Current authority changes after preparation: a transaction guard refuses it.
  await f.repository().setMembership(null, f.ownerId, false);
  await assert.rejects(() => jobs.commitUnit(released, prepared as any), { code: 'job_authority_revoked' });
  assert.equal((await f.call('/' + held.id)).status, 404);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM reference_sales_published_rows').first()).n, 0);
  await f.repository().setMembership(null, f.ownerId, true);
  const hiddenOwner = 'owner-west';
  await f.db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES(?,?,?,'owner','active',?)").bind(hiddenOwner, 'west-owner@example.test','West Owner',Date.now()).run();
  await f.repository().createTenant('west', hiddenOwner); await f.repository().setMembership('west', hiddenOwner, true); await f.populate('west', sales.slice(0, 20));
  const foreign = await jobs.request(input('first'), await f.authority('west', hiddenOwner));
  assert.equal((await f.call('/' + foreign.job.id)).status, 404);
  assert.ok(!(await f.call()).body.jobs.some((job: any) => job.id === foreign.job.id));
  await assert.rejects(() => jobs.get(first.id, { ...a, installationId: 'foreign-installation' }), { code: 'job_not_found' });
  await jobs.quiesce({ holder: 'boundary-process' }); await jobs.start({ holder: 'restored-process' });
  await f.db.prepare('DELETE FROM rer_job_activations WHERE job_id=?').bind(held.id).run();
  const restored = await f.call('/' + held.id); assert.equal(restored.body.job.reasonCode, 'restored_requires_reauthorization'); assert.ok(restored.body.job.savedState);
  assert.equal(await jobs.claim({ id: held.id }), null);
  assert.equal((await f.call('/' + held.id + '/resume', { expectedVersion: restored.body.job.version, operationKey: 'unsafe-restore' })).body.error.code, 'restored_requires_reauthorization');
  assert.equal((await f.call('', { ...input('own-owner-forged'), ownerId: hiddenOwner })).status, 400);
  assert.equal((await f.call('', input('cross-site'), { origin: 'https://foreign.example.test' })).status, 401);
  // A revoked member holds only their work. The owner can inspect/cancel it,
  // while ready work and restored authority are picked up by bounded ticks.
  await f.repository().createTenant('admission', f.ownerId); await f.repository().setMembership('admission', f.ownerId, true);
  await f.populate('admission', sales.slice(0, 20));
  await f.db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('member-east','member-east@example.test','East Member','member','active',?)").bind(Date.now()).run();
  await f.repository().setMembership('admission', 'member-east', true);
  const member = await f.authority('admission', 'member-east'), owner = await f.authority('admission');
  const boundedJobs = f.jobs({ maxList: 3, installationConcurrency: 1 });
  const old = [];
  for (let i = 0; i < 3; i++) old.push((await boundedJobs.request(input('member-' + i), member)).job);
  await f.repository().setMembership('admission', 'member-east', false);
  for (const job of old) assert.equal(await boundedJobs.claim({ id: job.id }), null);
  const headers = { 'x-rer-sales-tenant': 'admission' };
  const heldRead = await f.call('/' + old[0].id, undefined, headers);
  assert.equal(heldRead.status, 200);
  assert.deepEqual((await f.cli(['inspect', old[0].id, '--tenant', 'admission'])).job, heldRead.body.job);
  await assert.rejects(() => boundedJobs.get(old[0].id, member), { code: 'job_not_found' });
  const heldVersions = await f.db.prepare("SELECT id,version,starts,failures FROM rer_job_jobs WHERE tenant_key='admission' ORDER BY id").all();
  for (let i = 0; i < 3; i++) await boundedJobs.tick();
  assert.deepEqual(await f.db.prepare("SELECT id,version,starts,failures FROM rer_job_jobs WHERE tenant_key='admission' ORDER BY id").all(), heldVersions);
  const ownerCancelled = await f.call('/' + old[0].id + '/cancel', { expectedVersion: heldRead.body.job.version, operationKey: 'owner-cancels-revoked' }, headers);
  assert.equal(ownerCancelled.body.job.state, 'cancelled');
  const healthy = (await boundedJobs.request(input('healthy-owner'), owner)).job;
  await boundedJobs.tick();
  assert.ok((await boundedJobs.get(healthy.id, owner)).starts > 0);
  await f.repository().setMembership('admission', 'member-east', true);
  for (let i = 0; i < 8 && !(await boundedJobs.get(old[1].id, member)).starts; i++) await boundedJobs.tick();
  assert.ok((await boundedJobs.get(old[1].id, member)).starts > 0);
});
