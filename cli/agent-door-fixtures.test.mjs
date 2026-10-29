import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixtureSeed, buildFixture } from './tests/fixtures/agent-door/seed.mjs';
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

test('phase fixtures and native step hooks share disposable state and redact database refusals', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed');
 await buildFixture(root);
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 surface.verification.owner.initializer = 'context-owner.mjs';
 surface.verification.fixtures = { module: 'context-fixtures.mjs' };
 surface.verification.journey = 'context-journey.mjs';
 surface.journey.find(step => step.id === 'create').args.value = { $fixture: 'record', pointer: '/value' };
 await writeFile(join(root, 'context-owner.mjs'), `
export let ownerDatabase;
export default async function ({ database, request, origin, claim, displayName, returnTo }) {
 ownerDatabase = database;
 return request(origin + claim.path, { method: 'POST', redirect: 'manual',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: claim.token, displayName, returnTo }) });
}
`);
 await writeFile(join(root, 'context-fixtures.mjs'), `
import assert from 'node:assert/strict';
import { ownerDatabase } from './context-owner.mjs';
export const values = new Map();
export default async function ({ phase, database, now }) {
 assert.equal(database, ownerDatabase);
 assert.ok(Number.isFinite(now));
 const db = await database('DB');
 assert.ok(await db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first());
 const value = crypto.randomUUID();
 assert.ok(![...values.values()].includes(value));
 values.set(phase, value);
 return { values: { record: { value } } };
}
`);
 await writeFile(join(root, 'context-journey.mjs'), `
import assert from 'node:assert/strict';
import journey from './journey.mjs';
import { ownerDatabase } from './context-owner.mjs';
import { values } from './context-fixtures.mjs';
export default journey;
export async function beforeStep({ database, now, phase, step, args }) {
 assert.equal(database, ownerDatabase);
 assert.ok(Number.isFinite(now));
 const db = await database('DB');
 assert.ok(await db.prepare('SELECT COUNT(*) AS count FROM fixture_records').first());
 if (step.id === 'create') assert.equal(args.value, values.get(phase));
}
export const afterStep = beforeStep;
`);
 await writeFile(surfaceFile, JSON.stringify(surface));
 const report = [];
 async function verify() {
  try { return await checkAgentDoor(root, { report: line => report.push(line) }); }
  catch (error) { if (error.agentDoor) return error.agentDoor; throw error; }
 }
 const context = await verify();
 assert.equal(context.ok, true, JSON.stringify(context.points.filter(point => !point.ok)));
 for (const phase of ['autonomous', 'held']) assert.ok(context.points.some(point => point.ok && point.id.endsWith(`.${phase}.create`)));
 // The state reader cannot be used to manufacture protocol evidence. Bind a
 // fresh private value so even a SQL/driver failure must redact its contents.
 surface.verification.fixtures = { module: 'forbidden-database.mjs' };
 await writeFile(join(root, 'forbidden-database.mjs'), `
export default async function ({ database }) {
 const db = await database('DB');
 await db.prepare('UPDATE agent_door_audit SET tool=?').bind('private_' + crypto.randomUUID()).run();
 return { values: {} };
}
`);
 await writeFile(surfaceFile, JSON.stringify(surface));
 report.length = 0;
 const forbidden = await verify();
 assert.equal(forbidden.ok, false);
 assert.ok(forbidden.points.some(point => !point.ok && point.id === 'BASE-AGENT-013.phase2'
  && point.detail?.startsWith('agent_fixtures_database_unavailable:')));
 assert.doesNotMatch(report.join('\n'), /private_[a-f0-9-]+|UPDATE agent_door_audit|SET tool|operator_session=/);
 t.diagnostic(`disposable context: ${context.points.filter(point => point.ok).length}/${context.points.length}; protected-table preparation refused with a typed redacted diagnostic.`);
});
