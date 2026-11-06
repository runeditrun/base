import { createHash } from 'node:crypto';
import { door } from '../../../modules/import-kit/tests/door/fixture.ts';
import { createImportDoorHandler } from '../../../modules/import-kit/src/door/index.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = value => {
 const entries = Object.entries(value);
 if (entries.length !== 1 || !['ticket','user','organization','ticket_field','article'].includes(entries[0][0])) throw Error('unsupported_source');
 const [kind,row] = entries[0];
 if (!row || !Number.isSafeInteger(row.id) || kind === 'ticket' && (row.status === 'deleted' || row._offline?.comments_complete !== true)) throw Error('invalid_source');
 return { kind, sourceId: String(row.id), payload: row };
};
/** Real Base HTTP door and SQLite custody. This test source adopts the HH line
 * and package contracts; it claims no HH native mapping or deployment. */
export async function zendeskDoor(t, { packageAware = true } = {}) {
 const d = await door(t), packages = [];
 d.mount(createImportDoorHandler({ ...d.options, format: 'ndjson', parse,
  limits: { maxBytes: 32 * 1024 ** 3, maxRecordBytes: 64 * 1024 * 1024, maxRecords: 100_000 },
  ...(packageAware ? { package: { formats: ['happytohelp-zendesk-offline-v1'], maxBytes: 32 * 1024 ** 3, maxSegments: 16_384,
   async read(pkg) {
    const records = [], kept = new Map();
    for (const file of pkg.files) kept.set(file.path, Buffer.from(await pkg.read(file.path, 64 * 1024 * 1024)));
    for (const [name,bytes] of kept) if (/^records-\d+\.ndjson$/u.test(name)) {
     for (const line of bytes.toString().trim().split('\n')) if (line) {
      const wrapper = JSON.parse(line), record = parse(wrapper);
      for (const binding of wrapper.ticket?._offline?.attachments ?? []) {
       if (Object.hasOwn(binding, 'base64') || !kept.has(binding.path) || hash(kept.get(binding.path)) !== binding.sha256) throw Error('invalid_binding');
      }
      records.push(record);
     }
    }
    packages.push({ manifest: pkg.manifest, files: kept });
    return records;
   } } } : {}), mapping: { version: 'fixture-hh-contract-v1', map: () => ({ effects: [] }) } }));
 await d.enable();
 const observed = { uploads: [], plans: [], packages };
 Object.defineProperty(observed, 'plans', { get: () => d.runtime.native().prepare('SELECT p.id AS planId, u.id AS uploadId, p.bundle_sha256 AS bundleSha256 FROM ik_door_plans p JOIN ik_door_uploads u ON u.bundle_sha256=p.bundle_sha256 AND u.namespace=p.namespace WHERE p.complete=1').all() });
 return { ...d, state: observed, async applyLatest() {
  const latest = observed.plans.at(-1), planned = await d.call('plan', { uploadId: latest.uploadId }, { namespace: 'zendesk' });
  if (planned.status !== 200) throw Error('public_plan_failed');
  return d.apply(planned.body, { namespace: 'zendesk' });
 }, mint: action => d.token(action, { namespace: 'zendesk', maxBytes: 2_097_152, maxRecords: 100_000, maxChunks: 32 }) };
}
