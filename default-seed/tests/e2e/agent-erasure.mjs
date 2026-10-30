import assert from 'node:assert/strict';

const completed = new Map();

// The conformance tombstone is a refusal to replay personal payload. Prove
// completion independently through the existing native receipt and export doors.
async function verify({ request, origin, cookie }, args, marker) {
 const headers = { Origin: origin, Cookie: cookie };
 const receiptResponse = await request(origin + '/api/erasures/' + encodeURIComponent(marker.erasure_id), { headers });
 assert.equal(receiptResponse.status, 200);
 const { receipt } = await receiptResponse.json();
 assert.equal(receipt.id, marker.erasure_id);
 assert.equal(receipt.entity, 'person');
 assert.equal(receipt.phase, 'complete');
 assert.equal(receipt.requestedAt, marker.at);
 assert.equal(receipt.deleted.people, 1);
 const exported = await request(origin + '/api/people/' + encodeURIComponent(args.id) + '/export', { headers });
 assert.equal(exported.status, 404);
 await exported.body?.cancel();
}

export async function afterStep(context) {
 const { step, args, result } = context;
 if (step.tool !== 'base.people.erase' || !result?.tombstone) return;
 await verify(context, args, result.tombstone);
 completed.set(result.tombstone.erasure_id, { args, marker: result.tombstone });
}

export default async function (context) {
 assert.ok(completed.size >= 2, 'Both autonomous and held erasure must complete');
 for (const { args, marker } of completed.values()) await verify(context, args, marker);
 completed.clear();
}
