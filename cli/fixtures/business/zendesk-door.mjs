import { door } from '../../../modules/import-kit/tests/door/fixture.ts';
import { createImportDoorHandler } from '../../../modules/import-kit/src/door/index.ts';

/** A real Base public HTTP door, SQLite persistence, grant verification,
 * uploader and planner. This test source adopts the documented HH wrapped
 * NDJSON record contract; it claims no HH native mapping or deployment. */
export async function zendeskDoor(t) {
 const d = await door(t);
 d.mount(createImportDoorHandler({ ...d.options, format: 'ndjson', parse(value) {
  const entries = Object.entries(value);
  if (entries.length !== 1 || !['ticket','user','organization','ticket_field','article'].includes(entries[0][0])) throw Error('unsupported_source');
  const [kind,row] = entries[0];
  if (!row || !Number.isSafeInteger(row.id) || kind === 'ticket' && (row.status === 'deleted' || row._offline?.comments_complete !== true)) throw Error('invalid_source');
  return { kind, sourceId: String(row.id), payload: row };
 }, mapping: { version: 'fixture-hh-contract-v1', map: () => ({ effects: [] }) } }));
 await d.enable();
 const observed = { uploads: [], plans: [] };
 // Business reads its reported plan independently from the real persisted door.
 Object.defineProperty(observed, 'plans', { get: () => d.runtime.native().prepare('SELECT p.id AS planId, u.id AS uploadId, p.bundle_sha256 AS bundleSha256 FROM ik_door_plans p JOIN ik_door_uploads u ON u.bundle_sha256=p.bundle_sha256 AND u.namespace=p.namespace WHERE p.complete=1').all() });
 return { ...d, state: observed, mint: action => d.token(action, { namespace: 'zendesk', maxBytes: 2_097_152, maxRecords: 100_000, maxChunks: 32 }) };
}
