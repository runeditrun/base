import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
 surface.journey.find(step => step.id === 'create').resource.state.value = { $fixture: 'record', pointer: '/value' };
 await writeFile(join(root, 'context-owner.mjs'), `
import assert from 'node:assert/strict';
export let ownerDatabase;
export default async function ({ database, request, origin, claim, displayName, returnTo }) {
 const db = await database('DB');
 assert.throws(() => db.prepare('UPDATE fixture_records SET value=0'), { code: 'hosted_database_invalid' });
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
 assert.notEqual(database, ownerDatabase);
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
 assert.notEqual(database, ownerDatabase);
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

test('native continuation audits align later harness calls but unlinked embedded rows remain failures', { timeout: 120000 }, async t => {
 const root = await fixtureSeed(t, 'signed', { phaseFixtures: true });
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 surface.verification.invoke = { module: 'invoke.mjs', entrypoint: 'NativeJobs' };
 for (const action of ['stage', 'continue']) surface.tools.push({ name: `fixture.records.${action}`, scope: 'records:write', readOnly: false, classes: [action === 'stage' ? 'standard' : 'external'], clauses: ['BASE-AGENT-009'] });
 surface.journey.splice(surface.journey.findIndex(step => step.id === 'create') + 1, 0,
  { id: 'stage', tool: 'fixture.records.stage', args: { value: 'Retained native record' }, expect: [{ class: 'standard', facts: { measure: 1 } }] },
  { id: 'continue', tool: 'fixture.records.continue', args: { id: { $from: 'stage', pointer: '/id' } }, expect: [{ class: 'external', facts: { measure: 1, counterparty: 'known' } }] },
 );
 await writeFile(surfaceFile, JSON.stringify(surface));
 const deployFile = join(root, 'deploy.json'), deploy = JSON.parse(await readFile(deployFile, 'utf8'));
 deploy.vars.CONTINUATION_PROOF = true;
 await writeFile(deployFile, JSON.stringify(deploy));
 const configFile = join(root, 'dist/server/wrangler.json'), config = JSON.parse(await readFile(configFile, 'utf8'));
 config.queues = { producers: [{ binding: 'JOBS', queue: 'fixture-jobs' }], consumers: [{ queue: 'fixture-jobs', max_batch_size: 1, max_batch_timeout: 0, max_retries: 0 }] };
 await writeFile(configFile, JSON.stringify(config));
 await buildFixture(root);
 const positive = await checkAgentDoor(root, { report: () => {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });
 assert.equal(positive.ok, true, JSON.stringify(positive.points.filter(point => !point.ok)));
 const continuations = positive.points.filter(point => point.id.startsWith('BASE-AGENT-009.1.continuation.'));
 assert.ok(continuations.length > 0 && continuations.every(point => point.ok));
 assert.ok(positive.points.some(point => point.id === 'BASE-AGENT-009.1.events-audited' && point.ok));
 const invocations = positive.points.filter(point => point.id.startsWith('BASE-AGENT-012.invocation-'));
 assert.ok(invocations.length > 0 && invocations.every(point => point.ok));
 const repeated = { ...surface.journey.find(step => step.id === 'continue'), id: 'already-dispatched' };
 surface.journey.splice(surface.journey.findIndex(step => step.id === 'continue') + 1, 0, repeated);
 await writeFile(surfaceFile, JSON.stringify(surface));
 const refused = await checkAgentDoor(root, { report: () => {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });
 assert.equal(refused.ok, false);
 assert.ok(refused.points.some(point => point.id === 'BASE-AGENT-009.1.count' && point.ok));
 assert.ok(refused.points.filter(point => point.id.startsWith('BASE-AGENT-008.5.execution.')).every(point => point.ok));
 for (const id of ['BASE-AGENT-007.5.receipt.already-dispatched', 'BASE-AGENT-013.4.held.already-dispatched']) assert.ok(refused.points.some(point => point.id === id && !point.ok));
 surface.journey.splice(surface.journey.indexOf(repeated), 1);
 await writeFile(surfaceFile, JSON.stringify(surface));
 deploy.vars.FABRICATE_CONTINUATION = true;
 await writeFile(deployFile, JSON.stringify(deploy));
 const negative = await checkAgentDoor(root, { report: () => {} }).catch(error => { if (error.agentDoor) return error.agentDoor; throw error; });
 assert.ok(negative && !negative.ok);
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-009.1.count' && !point.ok));
 assert.ok(negative.points.some(point => point.id.startsWith('BASE-AGENT-009.1.continuation.') && !point.ok));
 assert.ok(negative.points.some(point => point.id.startsWith('BASE-AGENT-009.1.extra.') && !point.ok));
 assert.ok(negative.points.some(point => point.id === 'BASE-AGENT-007.7.differs-from-policy' && !point.ok));
 t.diagnostic(`Native continuations: ${positive.points.filter(point => point.ok).length}/${positive.points.length}; consumed native work: refused execution audited, receipt and completion fail; fabricated missing marker, unlinked operation, foreign agent/sponsor/consent/client and changed policy rule: rejected.`);
});

test('valid Business tokens refuse unknown, changed-email, inactive and excluded sponsors through the native door', { timeout: 420000 }, async t => {
 const root = await fixtureSeed(t, 'native');
 const surfaceFile = join(root, 'agent-surface.json'), surface = JSON.parse(await readFile(surfaceFile, 'utf8'));
 const emails = Object.fromEntries(['inactive', 'excluded'].map(kind => [kind, `${kind}-${randomUUID()}@example.invalid`]));
 surface.verification.sponsors = [{ label: 'owner' }, ...Object.entries(emails).map(([label, email]) => ({ label, email, initializer: 'negative-sponsors.mjs', negativeOnly: true }))];
 surface.verification.fixtures = { module: 'negative-fixtures.mjs' };
 await writeFile(surfaceFile, JSON.stringify(surface));
 await writeFile(join(root, 'negative-sponsors.mjs'), `
import initialize from './second-sponsor.mjs';
export const sponsors = {};
export default async function(c) {
 let response;
 if (c.label === 'inactive') response = await initialize(c);
 else {
  // Accept the native invitation but leave this person outside the app's
  // membership allow-list. This is the real owner/session/account lifecycle.
  const db = await c.database('DB');
  const mail = await db.prepare('SELECT body FROM fixture_mail WHERE email=? ORDER BY rowid DESC LIMIT 1').bind(c.email).first();
  const link = new URL(mail.body.match(/https:\\/\\/[^\\s]+/)[0]);
  response = await c.request(c.origin + '/auth/confirm', { method: 'POST', redirect: 'manual',
   headers: { Origin: c.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.searchParams.get('token') }) });
 }
 if (response.status !== 303) throw Error('Native invitation failed');
 sponsors[c.label] = { sub: c.sub, email: c.email };
 return response;
}
`);
 await writeFile(join(root, 'negative-fixtures.mjs'), `
import { sponsors } from './negative-sponsors.mjs';
export default async function({phase, request, origin, cookie}) {
 if (phase !== 'negative') return {};
 const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
 const listed = await request(origin + '/auth/operators', { headers });
 if (!listed.ok) throw Error('Native person list failed');
 const people = await listed.json(), inactive = people.find(person => person.email === sponsors.inactive.email);
 const suspended = await request(origin + '/auth/operator/status', { method: 'POST', headers,
  body: JSON.stringify({ operatorId: inactive.id, status: 'inactive' }) });
 if (!suspended.ok) throw Error('Native suspension failed');
 await suspended.body?.cancel();
 return { sponsors };
}
`);
 await buildFixture(root);
 const deployFile = join(root, 'deploy.json'), deploy = JSON.parse(await readFile(deployFile, 'utf8'));
 const kinds = ['unknown', 'changed-email', 'inactive', 'excluded'];
 async function verify(skip) {
  deploy.vars.SKIP_SPONSOR_CHECK = skip;
  await writeFile(deployFile, JSON.stringify(deploy));
  const lines = [], errors = [];
  const diagnostics = t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  let result;
  try { result = await checkAgentDoor(root, { report: line => lines.push(line) }); }
  catch (error) { result = error.agentDoor ?? error.details?.agentDoor; if (!result) throw error; }
  finally { diagnostics.mock.restore(); }
  const output = JSON.stringify({ lines, errors, result });
  for (const email of Object.values(emails)) assert.ok(!output.includes(email), 'Sponsor fixture email leaked into diagnostics');
  // The initializer retains the actual Business subjects only in its private module.
  const { sponsors } = await import(new URL('negative-sponsors.mjs', 'file://' + root + '/'));
  for (const person of Object.values(sponsors)) assert.ok(!output.includes(person.sub), 'Sponsor fixture subject leaked into diagnostics');
  return result;
 }
 const bypassed = await verify(true);
 for (const kind of ['unknown', 'inactive', 'excluded']) assert.ok(bypassed.points.some(point => point.id === `BASE-AGENT-004.sponsor.${kind}` && !point.ok), `Skipped sponsor admission must fail ${kind}`);
 // The door binds the token email to the subject's current native email, so an adapter that skips admission still cannot admit a changed address.
 assert.ok(bypassed.points.some(point => point.id === 'BASE-AGENT-004.sponsor.changed-email' && point.ok), 'The door must refuse a changed email even when the adapter skips admission');
 const native = await verify(false);
 assert.ok(!native.points.some(point => point.id.startsWith('BASE-AGENT-004.cross-sponsor')), 'Negative-only persons must not run successful cross-sponsor journeys');
 t.diagnostic(`Sponsor admission: ${JSON.stringify(native.points.filter(point => point.id.startsWith('BASE-AGENT-004.sponsor.')))}`);
 for (const kind of kinds) assert.ok(native.points.some(point => point.id === `BASE-AGENT-004.sponsor.${kind}` && point.ok), `Native sponsor admission must pass ${kind}`);
 t.diagnostic('Sponsor admission: bypassed adapter fails unknown, inactive and excluded while the door refuses changed-email; native adapter passes all four points.');
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
