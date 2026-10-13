import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createPortability, readArchive } from '../../modules/portability/index.mjs';

// Exercise the same module and migrated D1 store with its supported explicit
// session inclusion option; no application source or adapter is rewritten.
export async function withArchivePolicy(fixture, manifest, action) {
 const { getPlatformProxy } = createRequire(join(fixture.root, 'package.json'))('wrangler');
 const proxy = await getPlatformProxy({ configPath: join(fixture.root, 'wrangler.jsonc'), persist: { path: join(fixture.root, '.wrangler/state/v3') }, remoteBindings: false });
 try {
  const identities = manifest.excludedTables.filter(name => name.startsWith('oa_') || name.startsWith('oc_'));
  const policy = { product: manifest.product, includeTables: [...manifest.tables.map(table => table.name), ...identities], requiredConfiguration: manifest.requiredConfiguration };
  const service = await createPortability({ db: proxy.env.DB, policy });
  return await action(service);
 } finally { await proxy.dispose(); }
}

export async function policyArchive(service) {
 const id = await service.exports.create();
 try {
  while ((await service.exports.advance(id, { maxParts: 16 })).phase === 'building') {}
  const records = [];
  for await (const record of readArchive(await service.exports.download(id))) records.push(record);
  return records;
 } finally { await service.exports.abort(id); }
}

export async function importPolicyArchive(service, records) {
 const id = await service.imports.create(records[0]);
 try {
  for (const record of records) if (record.kind === 'part') await service.imports.uploadPart(id, record.index, record);
  return await service.imports.finalize(id, { contentHash: records.at(-1).contentHash, archiveHash: records.at(-1).archiveHash });
 } finally { await service.imports.abort(id); }
}
