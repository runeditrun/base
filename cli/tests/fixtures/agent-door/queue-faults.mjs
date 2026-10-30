import assert from 'node:assert/strict';

export default async function ({ phase, queues, database, request, origin }) {
 const db = await database('DB');
 const send = async input => {
  const response = await request(origin + '/fixture/queue', { method: 'POST', body: JSON.stringify(input) });
  const result = await response.json();
  assert.equal(response.status, result.status);
  return result;
 };
 const check = async (input, status) => {
  const result = await send(input);
  assert.deepEqual(result, { status, outcome: status === 200 ? 'queued' : 'failed-JOBS' });
 };
 if (phase !== 'initial') {
  // The previous fixture deliberately leaves JOBS failed. Phase preparation
  // must restore it before the next seed fixture is called.
  await check({ id: phase }, 200);
  await queues.fail('JOBS');
  return {};
 }
 for (const action of ['fail', 'restore']) {
  for (const binding of ['UNDECLARED', 'fixture-jobs', '', null, {}]) {
   assert.throws(() => queues[action](binding), { code: 'hosted_queue_invalid', message: 'Queue preparation requires a declared producer binding.' });
  }
 }
 queues.hold();
 await check({ id: 'held-send' }, 200);
 await check({ id: 'held-batch', batch: true }, 200);
 assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM fixture_queue_deliveries').first()).count, 0);
 await queues.fail('JOBS');
 await check({ id: 'rejected-send' }, 503);
 await check({ id: 'rejected-batch', batch: true }, 503);
 // These two bindings share one underlying queue; only JOBS is faulted.
 await check({ id: 'other-binding', binding: 'OTHER' }, 200);
 queues.release();
 await check({ id: 'rejected-after-release' }, 503);
 await queues.restore('JOBS');
 await check({ id: 'restored-send' }, 200);
 await check({ id: 'restored-batch', batch: true }, 200);
 const expected = ['held-send', 'held-batch-1', 'held-batch-2', 'other-binding', 'restored-send', 'restored-batch-1', 'restored-batch-2'].sort();
 let rows;
 for (let attempt = 0; attempt < 200; attempt++) {
  rows = (await db.prepare('SELECT id FROM fixture_queue_deliveries ORDER BY id').all()).results.map(row => row.id);
  if (rows.length >= expected.length) break;
  await new Promise(resolve => setTimeout(resolve, 20));
 }
 assert.deepEqual(rows, expected, 'Only successful producer calls may reach the real consumer');
 await queues.fail('JOBS');
 await queues.fail('OTHER');
 await queues.restore('JOBS');
 await check({ id: 'still-failed-other', binding: 'OTHER' }, 503);
 await queues.restore();
 await check({ id: 'all-restored', binding: 'OTHER' }, 200);
 await queues.fail('JOBS');
 return {};
}
