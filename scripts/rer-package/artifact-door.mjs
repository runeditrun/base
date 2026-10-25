import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { database, targets } from './artifact-sqlite.mjs';

export async function doorSmoke(entry) {
 const { door, d1 } = await import(pathToFileURL(entry).href);
 const { native, db } = database();
 try {
  await d1.initializeD1ImportStorage(db);
  await db.batch(door.importDoorSchema.map(query => db.prepare(query)));
  native.exec('CREATE TABLE records(destination TEXT,kind TEXT,id TEXT,revision TEXT,value_json TEXT,PRIMARY KEY(destination,kind,id));CREATE TABLE owners(id TEXT PRIMARY KEY);INSERT INTO owners VALUES(\'owner\')');
  const authority = { sql: "EXISTS(SELECT 1 FROM owners WHERE id='owner')" };
  const origin = 'https://release.example.test';
  const options = {
   database: db, targets: targets(d1.canonicalJson), installationId: 'release-probe', format: 'json',
   appOrigin: origin, ownerEmail: 'owner@example.test', ownerPrincipalId: 'owner', destination: 'workspace', namespace: 'people',
   authorize: async request => request.headers.get('Cookie') === 'release-owner' ? authority : null,
   parse(value) { return { kind: 'person', sourceId: value.id, payload: value }; },
   mapping: { version: '1', map(record) { return { effects: [{ targetKind: 'person', targetId: record.sourceId, value: record.payload }] }; } },
   intake: { formats: ['csv', 'json', 'ndjson'], allow: { csv: ['id', 'name'], json: ['/id', '/name'], ndjson: ['/id', '/name'] } },
  };
  assert.throws(() => door.createImportOperatorHandler({ ...options, namespace: '' }), error => error instanceof door.DoorError && error.code === 'invalid_configuration');
  const handler = door.createImportOperatorHandler(options);
  await door.writeImportDoorSettings(db, options.installationId, { enabled: true }, authority);
  async function call(action, body, headers = {}) {
   const response = await handler(new Request(origin + '/api/operator/import/' + action, {
    method: 'POST', headers: { Origin: origin, Cookie: 'release-owner', 'Content-Type': 'application/json', ...headers }, body,
   }));
   assert.ok(response); return { status: response.status, body: await response.json() };
  }
  async function json(action, body) { return call(action, JSON.stringify(body)); }
  const samples = [
   ['csv', '\ufeffid,name,passwordHash\r\np1,"Rene, 次😀",excluded-release-value\r\n'],
   ['ndjson', '{"id":"p1","name":"Rene, 次😀","credentials":"excluded-release-value"}\n'],
   ['json', '[{"id":"p1","name":"Rene, 次😀","factors":["excluded-release-value"]}]'],
  ];
  let uploaded;
  for (const [format, bytes] of samples) {
   uploaded = await call('uploads', bytes, { 'Content-Type': 'application/octet-stream', 'X-Import-Format': format, 'X-Import-Name': 'people-export' });
   assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
   assert.equal(uploaded.body.intake.sanitized, true);
  }
  const malformed = await call('uploads', 'id,name\np1,"unfinished', { 'Content-Type': 'application/octet-stream', 'X-Import-Format': 'csv' });
  assert.equal(malformed.status, 422); assert.equal(malformed.body.error, 'intake_malformed_row');
  const plan = await json('plan', { uploadId: uploaded.body.uploadId });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const refused = await json('apply', { planId: plan.body.planId, reviewedFingerprint: '0'.repeat(64) });
  assert.equal(refused.status, 403); assert.equal(refused.body.error, 'review_fingerprint_mismatch');
  const input = { planId: plan.body.planId, reviewedFingerprint: plan.body.fingerprint };
  let applied = await json('apply', input);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  if (applied.body.job.state === 'queued') applied = await json('apply', input); // The door's bounded creation and apply are separate work steps.
  assert.equal(applied.body.job.state, 'completed', JSON.stringify(applied.body));
  assert.deepEqual(JSON.parse(native.prepare('SELECT value_json FROM records').get().value_json), { id: 'p1', name: 'Rene, 次😀' });
  assert.equal((await json('reconcile', { planId: plan.body.planId })).body.ok, true);
  assert.equal((await json('apply', input)).body.job.id, applied.body.job.id);
  const undone = await json('undo', { planId: plan.body.planId });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.job.state, 'undone', JSON.stringify(undone.body));
  assert.equal(native.prepare('SELECT count(*) n FROM records').get().n, 0);
  for (const { name } of native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
   assert.ok(!JSON.stringify(native.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()).includes('excluded-release-value'), 'excluded intake value persisted in ' + name);
  }
  return { formats: samples.map(([format]) => format), normalized: true, typedRefusals: true, apply: 'completed', reconcile: true, replay: true, undo: 'undone', excludedValuesAbsent: true };
 } finally { native.close(); }
}
