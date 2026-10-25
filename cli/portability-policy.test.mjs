import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { portabilityFixture } from './fixtures/portability.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { makePart } from '../modules/portability/index.mjs';
import { ArchiveVerifier, ContentVerifier } from '../modules/portability/format.mjs';
import { fileRecords } from '../modules/portability/files.mjs';

test('public local restore retains seed policy closures, refuses forbidden rows and diagnoses malformed archives before migrations', { timeout: 10 * 60_000 }, async t => {
 const source = await portabilityFixture(t), target = await portabilityFixture(t);
 // Existing serializable object policies still run through real D1 export/import.
 await source.run(['export', '--output', 'exports/empty.rer']);
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('retained',3,125,'approved.example')");
 const exported = (await source.run(['export', '--output', 'exports/source.rer'])).at(-1);
 await copyFile(join(source.root, 'exports/source.rer'), join(target.root, 'exports/source.rer'));
 const input = ['import', '--input', 'exports/source.rer', '--yes'];
 const local = join(target.root, 'scripts/installer/local.mjs'), original = await readFile(local, 'utf8');
 const declare = declaration => writeFile(local, original.replace('policy: portabilityPolicy', declaration));
 const noData = () => assert.rejects(stat(join(target.root, '.wrangler/state')), { code: 'ENOENT' });
 const policyPath = join(target.root, 'scripts/installer/archive-policy.mjs');
 await writeFile(policyPath, `import { portabilityPolicy } from '../../src/core/platform/portability-policy.mjs';
const permittedDomains = new Set(['approved.example']);
export default { ...portabilityPolicy, validateStaged: async ({ read }) =>
 (await read('computed_entries')).every(row => permittedDomains.has(row.label)) };
`);
 await declare("policyModule: 'scripts/installer/archive-policy.mjs'");
 // Malformed primary and later-journal inputs, and bytes that are not UTF-8, have one constant diagnostic;
 // neither the private input nor V8's parser wording is exposed.
 await writeFile(join(target.root, 'exports/malformed.rer'), '{"private-domain-sentinel":\n', { mode: 0o600 });
 await writeFile(join(target.root, 'exports/not-utf8.rer'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]), { mode: 0o600 });
 const diagnosticEnv = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_NODE_AUTO: '0' });
 for (const args of [
  ['import', '--input', 'exports/malformed.rer', '--yes'],
  [...input, '--journal', 'exports/malformed.rer'],
  ['import', '--input', 'exports/not-utf8.rer', '--yes'],
 ]) {
  let failure;
  try { await promisify(execFile)(process.execPath, ['scripts/rer.mjs', ...args, '--json'], { cwd: target.root, env: diagnosticEnv, signal: t.signal }); }
  catch (error) { failure = error; }
  assert.equal(failure?.code, 2);
  const events = failure.stdout.trim().split('\n').map(JSON.parse), errors = events.filter(event => event.event === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'invalid_archive');
  assert.match(errors[0].message, /rer export --output/);
  assert.match(errors[0].message, /--target remote/);
  const diagnostic = failure.stdout + failure.stderr;
  assert.doesNotMatch(diagnostic, /archive_json/);
  assert.doesNotMatch(diagnostic, /private-domain-sentinel|SyntaxError|Unexpected|JSON at position|not valid for encoding/);
  await noData();
 }
 // Invalid declarations fail closed before any data migration, including a
 // nested function that JSON.stringify would otherwise silently remove.
 await writeFile(join(target.root, '../outside.mjs'), 'export default { product: "outside" };\n');
 await symlink('../outside.mjs', join(target.root, 'escaped-policy.mjs'));
 for (const [declaration, reason] of [
  ["policy: { ...portabilityPolicy, validateStaged: () => false }", /policy_module_required/],
  ["policy: { ...portabilityPolicy, acceptedSchemas: { ['a'.repeat(64)]: { upgradeRow: row => row } } }", /policy_module_required/],
  ["policyModule: 'scripts/installer/missing.mjs'", /invalid_policy_module/],
  ["policyModule: '../outside.mjs'", /invalid_policy_module/],
  ["policyModule: 'escaped-policy.mjs'", /invalid_policy_module/],
  ["policyModule: 'https://example.invalid/policy.mjs'", /invalid_policy_module/],
  ["policy: portabilityPolicy, policyModule: 'scripts/installer/archive-policy.mjs'", /ambiguous_policy/],
 ]) {
  await declare(declaration);
  assert.match((await target.run(input, 4)).find(event => event.event === 'error').message, reason);
  await noData();
 }
 await declare("policyModule: 'scripts/installer/invalid-policy.mjs'");
 for (const code of ['export const policy = { product: "invalid" };', 'export default { product: "invalid", validateStaged: true };']) {
  await writeFile(join(target.root, 'scripts/installer/invalid-policy.mjs'), code);
  assert.match((await target.run(input, 4)).find(event => event.event === 'error').message, /invalid_policy_module/);
  await noData();
 }
 await declare("policyModule: 'scripts/installer/archive-policy.mjs'");
 assert.match((await target.run([...input, '--platform', 'container'], 4)).find(event => event.event === 'error').message, /container_policy_module_unsupported/);
 await noData();

 const records = (await readFile(join(source.root, 'exports/source.rer'), 'utf8')).trim().split('\n').map(JSON.parse);
 const domain = records.flatMap(record => record.items ?? []).find(item => item.table === 'computed_entries');
 domain.row.label = 'forbidden.example';
 // The attack is logically invalid but fully integrity-valid: all three digest
 // layers are recomputed. Only the seed's executable staged validator refuses it.
 const content = new ContentVerifier(records[0]), archive = new ArchiveVerifier(records[0]);
 for (let i = 1; i < records.length - 1; i++) {
  records[i] = await makePart(records[i].index, records[i].items);
  archive.add(records[i]);
  for (const item of records[i].items) content.add(item);
 }
 Object.assign(records.at(-1), { contentHash: content.digest(), archiveHash: archive.digest() });
 const tampered = join(target.root, 'exports/tampered.rer');
 await writeFile(tampered, records.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
 for await (const record of fileRecords(tampered)) {} // proves full archive verification passes
 const refused = await target.run(['import', '--input', 'exports/tampered.rer', '--yes'], 4);
 assert.match(refused.find(event => event.event === 'error').message, /staged_validation/);
 const counts = records[0].tables.map(table => table.name).map(name =>
  `(SELECT COUNT(*) FROM "${name.replaceAll('"', '""')}")`).join(' + ');
 assert.equal((await target.data(`SELECT ${counts} AS n`))[0].results[0].n, 0, 'all destination product tables remain empty');
 assert.deepEqual((await target.data('SELECT kind,phase FROM rer_portability_jobs'))[0].results, [{ kind: 'import', phase: 'aborted' }], 'the refusal retains the existing aborted-job audit record');
 assert.deepEqual((await target.data('SELECT import_job,applying FROM rer_portability_state'))[0].results, [{ import_job: null, applying: 0 }], 'the refused restore releases its lock');
 assert.equal((await target.data("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'rer_portability_stage_%'"))[0].results[0].n, 0, 'failed restore staging is removed');
 // A file URL anchored to the adapter is also seed-owned; its module-local Set
 // must still be available in the native worker for this valid import to pass.
 await declare("policyModule: new URL('./archive-policy.mjs', import.meta.url)");
 const restored = (await target.run(input)).at(-1);
 assert.equal(restored.contentHash, exported.contentHash);
 const query = 'SELECT * FROM computed_entries ORDER BY id';
 assert.deepEqual((await target.data(query))[0].results, (await source.data(query))[0].results);
 await source.run(['reset', '--yes']);
 assert.equal((await source.run(input)).at(-1).contentHash, exported.contentHash);
 assert.deepEqual((await source.data(query))[0].results, (await target.data(query))[0].results);
});
