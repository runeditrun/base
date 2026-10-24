// Regenerate only the appended publisher-project vectors; historical v1 bytes stay intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { publicEntry, envelope } from '../signing-key.mjs';
import { b64, canonicalBytes, ENROLMENT_TYPE, PAYLOAD_TYPE, sha256 } from '../signature.mjs';

const output = new URL('./release-signature-vectors.json', import.meta.url);
const original = readFileSync(output, 'utf8');
const historical = JSON.parse(original).filter(row => !/^(v2 |anchors v1 )/.test(row.name));
const template = historical[0];
const baseStatement = JSON.parse(Buffer.from(JSON.parse(Buffer.from(template.envelope, 'base64')).payload, 'base64'));
const copy = value => structuredClone(value);
const issuedAt = baseStatement.issuedAt;
const repository = 'https://github.com/just-every/run-beam';
const publisher = 'just-every';
const githubOwner = { login: 'just-every', id: 71005 };

async function ephemeralKey() {
  // EPHEMERAL TEST-SCOPE ONLY: private keys stay in memory and are never serialized.
  const { privateKey } = generateKeyPairSync('ed25519');
  const entry = await publicEntry(privateKey, {
    scope: 'test', publisher, githubOwner,
    notBefore: '2026-10-01T00:00:00Z', notAfter: '2028-10-01T00:00:00Z',
    issuedAt: '2026-10-01T00:00:00Z', unsignedThrough: { 'just-every/beam': '1.1.0' },
  });
  return { privateKey, entry: { ...entry, review: 'public synthetic conformance vector', projects: ['learning/beam', 'just-every/beam'] } };
}

const key = await ephemeralKey();
const otherKey = await ephemeralKey();
const anchors = {
  schemaVersion: 2, environment: 'test', serial: 1,
  legacyUnsigned: { 'never-enrolled/app': '0.1.0' }, keys: [key.entry],
};
function statement(project = 'learning/beam', fields = {}) {
  return { ...copy(baseStatement), publisher, project, repository, keyId: key.entry.keyId, ...fields };
}
function signed(project, fields = {}) {
  return b64(Buffer.from(JSON.stringify(envelope(key.privateKey, key.entry.keyId, PAYLOAD_TYPE, statement(project, fields)))));
}
function context(project = 'learning/beam') {
  return { ...copy(template.context), expect: { ...template.context.expect, project, repository } };
}
function changedAnchor(change) {
  const result = copy(anchors);
  change(result.keys[0], result);
  return result;
}
const rows = [];
function add(name, expected, { project = 'learning/beam', anchorSet = anchors, payload = signed(project), ctx = context(project) } = {}) {
  rows.push({ name, envelope: payload, anchors: copy(anchorSet), context: copy(ctx), expected });
}

add('v2 listed external learning/beam signed by just-every', 'VERIFIED');
add('v2 listed own namespace', 'VERIFIED', { project: 'just-every/beam' });
for (const project of ['learning/not-listed', 'just-every/not-listed', 'learning/Beam']) {
  add(`v2 unlisted exact project ${project}`, 'PUBLISHER_MISMATCH', { project });
}
add('v2 malformed statement trailing slash', 'STATEMENT_INVALID', { project: 'learning/beam/' });
add('v2 another key with same publisher and owner cannot widen signing key projects', 'PUBLISHER_MISMATCH', {
  project: 'learning/not-listed',
  anchorSet: { ...copy(anchors), keys: [copy(key.entry), { ...copy(otherKey.entry), projects: ['learning/not-listed'] }] },
});
add('v2 one project is sufficient', 'VERIFIED', { anchorSet: changedAnchor(entry => { entry.projects = ['learning/beam']; }) });
const maximumProjects = ['learning/beam', ...Array.from({ length: 1023 }, (_, i) => `learning/project-${i}`)];
add('v2 1024 projects allowed', 'VERIFIED', { anchorSet: changedAnchor(entry => { entry.projects = maximumProjects; }) });
for (const [label, projects] of [
  ['duplicate', ['learning/beam', 'learning/beam']], ['empty list', []], ['empty string', ['']],
  ['malformed project', ['learning/beam/extra']], ['trailing slash', ['learning/beam/']],
  ['number member', [42]], ['null member', [null]], ['object member', [{}]], ['array member', [[]]],
  ['number list', 42], ['null list', null], ['object list', {}], ['string list', 'learning/beam'],
  ['1025 projects', [...maximumProjects, 'learning/overflow']],
]) {
  add(`v2 invalid projects ${label}`, 'ANCHORS_INVALID', {
    anchorSet: changedAnchor(entry => { entry.projects = projects; }), payload: null,
  });
}
add('v2 missing projects', 'ANCHORS_INVALID', { anchorSet: changedAnchor(entry => { delete entry.projects; }), payload: null });
add('v2 unknown top projects', 'ANCHORS_INVALID', { anchorSet: { ...copy(anchors), projects: ['learning/beam'] }, payload: null });
add('v2 unknown key field', 'ANCHORS_INVALID', { anchorSet: changedAnchor(entry => { entry.unreviewed = true; }), payload: null });
add('v2 unknown githubOwner field', 'ANCHORS_INVALID', { anchorSet: changedAnchor(entry => { entry.githubOwner.unreviewed = true; }), payload: null });
for (const [label, extra] of [['unknown field', { unreviewed: true }], ['projects field', { projects: ['learning/beam'] }]]) {
  const claim = JSON.parse(Buffer.from(key.entry.enrolment.payload, 'base64'));
  add(`v2 enrolment claim ${label} correctly signed`, 'ANCHORS_INVALID', {
    anchorSet: changedAnchor(entry => { entry.enrolment = envelope(key.privateKey, key.entry.keyId, ENROLMENT_TYPE, { ...claim, ...extra }); }), payload: null,
  });
}
add('v2 unknown enrolment envelope field', 'ANCHORS_INVALID', { anchorSet: changedAnchor(entry => { entry.enrolment.unreviewed = true; }), payload: null });
const extraEnvelope = JSON.parse(Buffer.from(signed(), 'base64'));
extraEnvelope.unreviewed = true;
add('v2 unknown release envelope field', 'ENVELOPE_INVALID', { payload: b64(Buffer.from(JSON.stringify(extraEnvelope))) });

const v1 = changedAnchor((entry, set) => { delete entry.projects; set.schemaVersion = 1; });
add('anchors v1 retains external prefix statement refusal', 'STATEMENT_INVALID', { anchorSet: v1 });
add('anchors v1 retains own namespace authority', 'VERIFIED', { anchorSet: v1, project: 'just-every/not-listed' });
add('anchors v1 refuses key projects', 'ANCHORS_INVALID', { anchorSet: { ...copy(anchors), schemaVersion: 1 }, payload: null });
add('anchors v1 refuses top projects', 'ANCHORS_INVALID', { anchorSet: { ...copy(v1), projects: ['learning/beam'] }, payload: null });

add('v2 compromised key without reviewed keep digest', 'KEY_REVOKED', { anchorSet: changedAnchor(entry => { Object.assign(entry, { status: 'compromised', compromisedAt: issuedAt, keepStatements: [] }); }) });
const statementDigest = await sha256(canonicalBytes(statement()));
add('v2 compromised key with reviewed keep digest', 'VERIFIED', { anchorSet: changedAnchor(entry => { Object.assign(entry, { status: 'compromised', compromisedAt: issuedAt, keepStatements: [statementDigest] }); }) });
for (const [label, retiredAt, expected] of [
  ['before retirement', '2026-10-13T00:00:01Z', 'VERIFIED'], ['at retirement', issuedAt, 'KEY_RETIRED'],
]) {
  add(`v2 retired key ${label}`, expected, { anchorSet: changedAnchor(entry => { Object.assign(entry, { status: 'retired', retiredAt }); }) });
}
add('v2 statement before validity', 'KEY_OUTSIDE_VALIDITY', { payload: signed(undefined, { issuedAt: '2026-09-30T23:59:59Z' }) });
add('v2 statement at expiry', 'KEY_OUTSIDE_VALIDITY', { payload: signed(undefined, { issuedAt: key.entry.notAfter }), ctx: { ...context(), now: Date.parse(key.entry.notAfter) } });
add('v2 statement in future', 'ISSUED_IN_FUTURE', { payload: signed(undefined, { issuedAt: '2027-10-13T00:00:00Z' }) });
add('v2 environment mismatch', 'ANCHORS_INVALID', { anchorSet: { ...copy(anchors), environment: 'production' }, payload: null });
add('v2 production anchors refuse test key', 'ANCHORS_INVALID', { anchorSet: { ...copy(anchors), environment: 'production' }, payload: null, ctx: { environment: 'production' } });
add('v2 test key refused by production verifier', 'KEY_TEST_REFUSED', { anchorSet: { ...copy(anchors), environment: 'production', keys: [] }, ctx: { environment: 'production', now: template.context.now } });
add('v2 stale serial equal', 'ANCHORS_STALE', { ctx: { ...context(), minimumSerial: 1 }, payload: null });
add('v2 stale serial older', 'ANCHORS_STALE', { ctx: { ...context(), minimumSerial: 2 }, payload: null });
add('v2 legacy floor cannot overlap enrolled publisher', 'ANCHORS_INVALID', { anchorSet: { ...copy(anchors), legacyUnsigned: { 'just-every/beam': '1.1.0' } }, payload: null });
for (const [label, project, version, expected] of [
  ['enrolled floor', 'just-every/beam', '1.1.0', 'UNSIGNED_LEGACY'],
  ['above enrolled floor', 'just-every/beam', '1.2.0', 'SIGNATURE_MISSING'],
  ['legacy floor', 'never-enrolled/app', '0.1.0', 'UNSIGNED_LEGACY'],
  ['above legacy floor', 'never-enrolled/app', '0.2.0', 'SIGNATURE_MISSING'],
  ['listing creates no unsigned floor', 'learning/beam', '1.1.0', 'SIGNATURE_MISSING'],
]) {
  add(`v2 unsigned ${label} unchanged`, expected, { payload: false, ctx: {
    environment: 'test', now: template.context.now, expect: { project, version, tag: `v${version}` }, unsigned: { project, version },
  } });
}

// Keep the historical JSON prefix verbatim, adding only its separating comma.
const generatedStart = original.search(/\n  \{\n    "name": "(?:v2 |anchors v1 )/);
const prefix = generatedStart < 0 ? original.slice(0, original.lastIndexOf('\n]')) : original.slice(0, generatedStart).replace(/,$/, '');
if (JSON.stringify(JSON.parse(prefix + '\n]')) !== JSON.stringify(historical)) throw new Error('Generated rows must follow all historical vectors.');
writeFileSync(output, prefix + ',' + JSON.stringify(rows, null, 2).slice(1, -1) + ']\n');
console.log(`Appended ${rows.length} publisher-project vectors.`);
