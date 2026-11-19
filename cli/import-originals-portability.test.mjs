import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { parseJsonc } from './jsonc.mjs';
import { installD1Preflight } from '../modules/container/adapters/d1-workerd-setup.mjs';
import { createImportOperatorHandler, writeImportDoorSettings } from '../modules/import-kit/src/door/operator.ts';
import { readD1ImportOriginals } from '../modules/import-kit/src/d1/index.ts';
import { parsePeople, peopleMapping, personTargets } from '../default-seed/src/core/features/people/imports.server.ts';
import { door, finishDoor, planPeople } from '../default-seed/tests/local-journey/import-door.mjs';

const appOrigin = 'http://localhost', ownerEmail = 'owner@example.test';
const destination = 'people', installationId = 'base:people', principalId = 'role:owner';
const authority = { sql: 'SELECT 1' }; // Auth belongs to the seed. Exercise the reviewed operator flow.
const chunkTypes = "SELECT DISTINCT typeof(bytes) AS storage FROM ik_d1_original_chunks";

async function withImportDoor(root, use) {
 const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 const configPath = join(root, 'move-in-test.json');
 await writeFile(configPath, JSON.stringify({ compatibility_date: config.compatibility_date, d1_databases: config.d1_databases }));
 const require = createRequire(join(root, 'package.json'));
 const { getPlatformProxy } = require('wrangler');
 installD1Preflight(createRequire(require.resolve('wrangler/package.json'))('miniflare').D1_PLUGIN);
 const proxy = await getPlatformProxy({ configPath, persist: { path: join(root, '.wrangler/state/v3') }, remoteBindings: false });
 try {
  const database = proxy.env.DB;
  const context = job => ({ destination, namespace: job.namespace, mappingVersion: job.mappingVersion,
   storage: { database, targets: personTargets }, authorization: { principalId, predicate: () => authority } });
  const handler = createImportOperatorHandler({
   database, targets: personTargets, ownerPrincipalId: principalId, destination, format: 'json', parse: parsePeople,
   mapping: peopleMapping, installationId, appOrigin, ownerEmail, namespace: destination, authorize: async () => authority,
  });
  const call = async (method, route, body) => {
   const response = await handler(new Request(appOrigin + route, {
    method, body: JSON.stringify(body), headers: { origin: appOrigin, 'content-type': 'application/json' },
   }));
   return { status: response.status, json: await response.json() };
  };
  return await use({ call, database, context });
 } finally { await proxy.dispose(); }
}

test('rer export and import preserve the exact original of a reviewed Move in from an older installation', { timeout: 10 * 60_000 }, async t => {
 const source = await portabilityFixture(t, { generated: false });
 const target = await portabilityFixture(t, { generated: false });
 const archive = 'exports/moved.rer';
 await source.run(['export', '--output', 'exports/empty.rer']); // Apply the real local migrations.
 const people = [{ ref: 'staff-1', name: 'José Márquez 🌱', email: 'jose@example.test',
  details: { note: 'Employee from a prior installation. '.repeat(3200) } }];
 const uploaded = Buffer.from(JSON.stringify(people));
 const { plan, job } = await withImportDoor(source.root, async ({ call, database, context }) => {
  await writeImportDoorSettings(database, installationId, { enabled: false }, authority);
  const plan = await planPeople(call, 'previous-people.json', people);
  const job = await finishDoor(call, 'apply', plan);
  assert.ok((await database.prepare('SELECT count(*) AS n FROM ik_d1_original_chunks').first()).n > 1);
  assert.deepEqual((await database.prepare(chunkTypes).all()).results, [{ storage: 'blob' }]);
  // Re-create the older SQLite representation without changing any content.
  await database.prepare('UPDATE ik_d1_original_chunks SET bytes=CAST(bytes AS TEXT)').run();
  const originals = await readD1ImportOriginals(job.id, context(job));
  assert.deepEqual(Buffer.from(originals[0].original.base64, 'base64'), uploaded);
  return { plan, job };
 });
 const saved = (await source.run(['export', '--output', archive])).at(-1);
 assert.deepEqual((await source.data(chunkTypes))[0].results, [{ storage: 'text' }]);
 await copyFile(join(source.root, archive), join(target.root, archive));
 const restored = (await target.run(['import', '--input', archive, '--yes'])).at(-1);
 assert.equal(restored.contentHash, saved.contentHash);
 await withImportDoor(target.root, async ({ call, database, context }) => {
  assert.deepEqual((await database.prepare(chunkTypes).all()).results, [{ storage: 'blob' }]);
  const originals = await readD1ImportOriginals(job.id, context(job));
  assert.equal(originals.length, 1);
  assert.deepEqual(Buffer.from(originals[0].original.base64, 'base64'), uploaded);
  const reconciled = await door(call, 'reconcile', { planId: plan.planId });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.json.ok, true);
  assert.equal(reconciled.json.counts.present, people.length);
  const catchup = await planPeople(call, 'catch-up.json', people, true);
  assert.equal(catchup.differences.unchanged.length, people.length);
 });
});
