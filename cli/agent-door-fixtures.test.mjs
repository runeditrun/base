import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixtureSeed } from './tests/fixtures/agent-door/seed.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';
import { checkAgentDoor } from './agent-door.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');

test('native client receipts and consumed phase state require real fresh fixtures through rer verify', { timeout: 420000 }, async t => {
 const root = await fixtureSeed(t, 'signed', { phaseFixtures: true });
 const env = await isolatedQueue(t, { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' });
 async function verify() {
  const output = await run(process.execPath, [join(base, 'bin/rer.mjs'), 'verify', '--cwd', root, '--json'], { env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).catch(error => error);
  const rows = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.doesNotMatch(output.stdout + output.stderr, /fixture_native_[a-f0-9]{64}|operator_session=|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const result = rows.findLast(row => row.agentDoor)?.agentDoor;
  if (result) return result;
  assert.ok(rows.some(row => row.code === 'agent_door_failed'), rows.map(row => row.code ?? row.event).join(', '));
  const points = output.stderr.split('\n').flatMap(line => {
   const match = /^(PASS|FAIL) (BASE-AGENT-\S+?)(?:: (.*))?$/.exec(line);
   return match ? [{ id: match[2], ok: match[1] === 'PASS', detail: match[3] }] : [];
  });
  assert.ok(points.length > 0, 'Failed verification must report its conformance points');
  return { ok: false, points };
 }
 const declared = await verify();
 assert.equal(declared.ok, true, JSON.stringify(declared.points.filter(point => !point.ok)));
 for (const round of ['autonomous', 'held', 'blocked.destructive']) assert.ok(declared.points.some(point => point.ok && point.id.includes(round) && point.id.endsWith('.erase')));
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 delete surface.verification.fixtures;
 await writeFile(surfaceFile, JSON.stringify(surface));
 const absent = await verify();
 assert.equal(absent.ok, false);
 assert.ok(absent.points.some(point => !point.ok && point.id.endsWith('.client')));
 surface.verification.fixtures = { module: 'missing-client.mjs' };
 await writeFile(join(root, 'missing-client.mjs'), "import prepare from './phase-fixtures.mjs'; export default async c => ({values:(await prepare(c)).values});\n");
 await writeFile(surfaceFile, JSON.stringify(surface));
 const noClient = await verify();
 assert.equal(noClient.ok, false);
 assert.ok(noClient.points.some(point => !point.ok && point.detail?.includes('native client fixture is unavailable')));
 surface.verification.fixtures = { module: 'stale-fixtures.mjs' };
 await writeFile(join(root, 'stale-fixtures.mjs'), "import prepare from './phase-fixtures.mjs'; let saved; export default async c => c.phase === 'initial' ? prepare(c) : saved ??= await prepare(c);\n");
 await writeFile(surfaceFile, JSON.stringify(surface));
 const stale = await verify();
 assert.equal(stale.ok, false);
 assert.ok(stale.points.some(point => !point.ok && point.id.includes('held') && point.id.endsWith('.erase')));
 t.diagnostic(`native/phase fixtures: declared ${declared.points.filter(point => point.ok).length}/${declared.points.length}; omitted ${absent.points.filter(point => !point.ok).length} failures; missing native client ${noClient.points.filter(point => !point.ok).length} failures; reused consumed state ${stale.points.filter(point => !point.ok).length} failures.`);
});

test('native aged delivery and scheduled work require contained fresh preparation', { timeout: 180000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 const { createRequire } = await import('node:module');
 const require = createRequire(join(base, 'default-seed/package.json'));
 const entry = join(base, 'cli/fixtures/timed-native.mjs');
 await require('esbuild').build({ entryPoints: [entry], outfile: join(root, 'dist/server/index.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], plugins: [{ name: 'native-history-seed', setup(build) {
  build.onResolve({ filter: /agent-door\/index\.ts$/ }, args => args.importer.endsWith('/application.mjs') ? { path: entry } : undefined);
  build.onResolve({ filter: /^\.\/credentials\.mjs$/ }, () => ({ path: join(root, 'credentials.mjs') }));
 } }] });
 await writeFile(join(root, 'dist/server/migrations/0099_history.sql'), `
CREATE TABLE fixture_history_ready(receipt_id TEXT PRIMARY KEY REFERENCES fixture_receipts(id));
CREATE TABLE fixture_history_probe(value TEXT);
CREATE TRIGGER fixture_history_probe_guard AFTER INSERT ON fixture_history_probe BEGIN UPDATE agent_door_audit SET tool=NEW.value; END;
`);
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 surface.tools.push({ name: 'fixture.history.consume', scope: 'records:write', readOnly: false, classes: ['standard'], clauses: ['BASE-AGENT-013'] });
 surface.journey.push({ id: 'aged-scheduled', tool: 'fixture.history.consume', args: { receiptId: { $fixture: 'delivery', pointer: '/id' } }, expect: [{ class: 'standard' }] });
 surface.verification.owner.initializer = 'readonly-owner.mjs';
 await writeFile(join(root, 'readonly-owner.mjs'), `
import assert from 'node:assert/strict';
export default async function ({ database, request, origin, claim, displayName, returnTo }) {
 const db = await database('DB');
 assert.throws(() => db.prepare('UPDATE fixture_receipts SET created_at=0'), { code: 'hosted_database_invalid' });
 return request(origin + claim.path, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: claim.token, displayName, returnTo }) });
}
`);
 surface.verification.fixtures = { module: 'context-fixtures.mjs' };
 surface.verification.journey = 'context-journey.mjs';
 await writeFile(join(root, 'context-fixtures.mjs'), `
import assert from 'node:assert/strict';
export const deliveries = new Map();
export default async function ({ phase, tool }) {
 if (phase === 'initial') return { values: {} };
 const created = await tool('fixture.records.create', { value: crypto.randomUUID(), idempotency_key: crypto.randomUUID() });
 const delivered = await tool('fixture.records.deliver', { id: created.result.structuredContent.id, idempotency_key: crypto.randomUUID() });
 const delivery = delivered.result.structuredContent;
 assert.ok(delivery?.id);
 assert.ok(![...deliveries.values()].includes(delivery.id));
 deliveries.set(phase, delivery.id);
 return { values: { delivery } };
}
`);
 await writeFile(join(root, 'context-journey.mjs'), `
import assert from 'node:assert/strict';
import journey from './journey.mjs';
import { deliveries } from './context-fixtures.mjs';
export default journey;
export async function beforeStep({ database, scheduled, now, phase, step, args }) {
 if (step.id !== 'aged-scheduled') return;
 assert.equal(args.receiptId, deliveries.get(phase));
 const db = await database('DB');
 assert.equal(await db.prepare('SELECT receipt_id FROM fixture_history_ready WHERE receipt_id=?').bind(args.receiptId).first(), null);
 await db.prepare('UPDATE fixture_receipts SET created_at=? WHERE id=?').bind(now - 7200000, args.receiptId).run();
 await scheduled({ scheduledTime: now });
 assert.ok(await db.prepare('SELECT receipt_id FROM fixture_history_ready WHERE receipt_id=?').bind(args.receiptId).first());
}
export async function afterStep({ database, now, step, result }) {
 if (step.id !== 'aged-scheduled') return;
 assert.ok(Number.isFinite(now));
 const db = await database('DB');
 assert.ok(await db.prepare('SELECT id FROM fixture_records WHERE id=?').bind(result.id).first());
}
`);
 await writeFile(surfaceFile, JSON.stringify(surface));
 const report = [];
 async function verify() {
  try { return await checkAgentDoor(root, { report: line => report.push(line) }); }
  catch (error) { if (error.agentDoor) return error.agentDoor; throw error; }
 }
 // The real rule fails without preparation, then succeeds through the same
 // public tool and mandatory autonomous/held policy journeys.
 const hookFile = join(root, 'context-journey.mjs'), preparedHook = await readFile(hookFile, 'utf8');
 await writeFile(hookFile, 'export default async function () {}');
 const absent = await verify();
 assert.ok(absent.points.some(point => !point.ok && point.id.endsWith('.autonomous.aged-scheduled')));
 // Use a distinct module URL so the native module loader sees the new hook.
 await writeFile(join(root, 'prepared-journey.mjs'), preparedHook);
 surface.verification.journey = 'prepared-journey.mjs';
 await writeFile(surfaceFile, JSON.stringify(surface));
 const prepared = await verify();
 assert.equal(prepared.ok, true, JSON.stringify(prepared.points.filter(point => !point.ok)));
 for (const phase of ['autonomous', 'held']) assert.ok(prepared.points.some(point => point.ok && point.id.endsWith(`.${phase}.aged-scheduled`)));
 // Direct and trigger-mediated writes must roll back, retain no probe row,
 // and return only a typed, redacted phase error.
 await writeFile(join(root, 'forbidden-database.mjs'), `
import assert from 'node:assert/strict';
export default async function ({ database }) {
 const db = await database('DB');
 const before = (await db.prepare('SELECT * FROM agent_door_audit').all()).results;
 for (const sql of ['UPDATE agent_door_audit SET tool=?', 'INSERT INTO fixture_history_probe(value) VALUES(?)']) {
  await assert.rejects(async () => db.prepare(sql).bind('private_' + crypto.randomUUID()).run());
 }
 assert.deepEqual((await db.prepare('SELECT * FROM agent_door_audit').all()).results, before);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fixture_history_probe').first()).n, 0);
 await db.prepare('UPDATE agent_door_audit SET tool=?').bind('private_' + crypto.randomUUID()).run();
}
`);
 surface.verification.fixtures = { module: 'forbidden-database.mjs' };
 await writeFile(surfaceFile, JSON.stringify(surface));
 report.length = 0;
 const forbidden = await verify();
 assert.ok(forbidden.points.some(point => !point.ok && point.id === 'BASE-AGENT-013.phase2' && point.detail?.startsWith('agent_fixtures_database_unavailable:')));
 assert.doesNotMatch(report.join('\n'), /private_[a-f0-9-]+|UPDATE agent_door_audit|fixture_history_probe|operator_session=/);
 await writeFile(join(root, 'forbidden-journey.mjs'), `
export default async function () {}
export async function beforeStep({ database }) {
 const db = await database('DB');
 await db.prepare('UPDATE agent_door_audit SET tool=?').bind('private_' + crypto.randomUUID()).run();
}
`);
 surface.verification.fixtures = { module: 'context-fixtures.mjs' };
 surface.verification.journey = 'forbidden-journey.mjs';
 await writeFile(surfaceFile, JSON.stringify(surface));
 report.length = 0;
 const forbiddenStep = await verify();
 assert.ok(forbiddenStep.points.some(point => !point.ok && point.id === 'BASE-AGENT-013.phase2' && point.detail?.startsWith('agent_fixtures_database_unavailable:')));
 assert.doesNotMatch(report.join('\n'), /private_[a-f0-9-]+|UPDATE agent_door_audit|operator_session=/);

 t.diagnostic(`native history: unprepared ${absent.points.filter(point => point.ok).length}/${absent.points.length}; prepared ${prepared.points.filter(point => point.ok).length}/${prepared.points.length}; direct/trigger protocol writes refused and rolled back.`);
});
