import { writeFileSync } from 'node:fs';
import {
  ENROLMENT_TYPE,
  PAYLOAD_TYPE,
  b64,
  canonical,
  canonicalBytes,
  keyIdFor,
  pae,
  sha256,
} from '../signature.mjs';

const encoder = new TextEncoder();
const issuedAt = '2026-10-13T00:00:00Z';
const now = Date.parse(issuedAt);
const notBefore = '2026-10-01T00:00:00Z';
const notAfter = '2028-10-01T00:00:00Z';
// Existing public Octocat example context; all bundle bytes are synthetic and keys
// are throwaway test keys kept in memory, with only public keys exported.
const owner = { login: 'octocat', id: 583231 };
const repository = 'https://github.com/octocat/hello-world';

async function throwawayKey(publisher, githubOwner) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    pair,
    publicKey: b64(raw),
    keyId: await keyIdFor('test', raw),
    publisher,
    githubOwner,
  };
}

async function signature(key, type, body) {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key.pair.privateKey, pae(type, body)));
}

async function envelope(key, body, options = {}) {
  const signer = options.signer ?? key;
  const type = options.type ?? PAYLOAD_TYPE;
  return encoder.encode(JSON.stringify({
    payloadType: type,
    payload: b64(body),
    signatures: [{ keyid: options.keyid ?? key.keyId, sig: b64(await signature(signer, type, body)) }],
  }));
}

async function enrolment(key, options = {}) {
  const claim = {
    schemaVersion: 1,
    keyId: key.keyId,
    publicKey: key.publicKey,
    publisher: key.publisher,
    githubOwner: key.githubOwner,
    notBefore,
    notAfter,
    issuedAt: notBefore,
    unsignedThrough: options.unsignedThrough ?? {},
  };
  return envelope(key, canonicalBytes(claim), {
    type: ENROLMENT_TYPE,
    signer: options.signer ?? key,
    keyid: options.keyid ?? key.keyId,
  });
}

async function anchor(key, options = {}) {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    publisher: key.publisher,
    githubOwner: key.githubOwner,
    notBefore,
    notAfter,
    status: 'active',
    enrolment: JSON.parse(new TextDecoder().decode(await enrolment(key, options))),
    review: 'public conformance vector',
    ...options.entry,
  };
}

function copy(value) {
  return structuredClone(value);
}

function withAnchor(anchors, keyId, changes) {
  return {
    ...copy(anchors),
    keys: anchors.keys.map(key => key.keyId === keyId ? { ...copy(key), ...changes } : copy(key)),
  };
}

function bytes(text) {
  return encoder.encode(text);
}

function changed(input, offset = 0) {
  const output = new Uint8Array(input);
  output[offset] ^= 1;
  return output;
}

function editEnvelope(raw, change) {
  const value = JSON.parse(new TextDecoder().decode(raw));
  change(value);
  return encoder.encode(JSON.stringify(value));
}

function decoded(text) {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function filesAsBase64(files) {
  return Object.fromEntries([...files].map(([path, value]) => [path, b64(value)]));
}

async function manifestFor(sourceFiles) {
  const manifest = [];
  for (const [path, content] of [...sourceFiles].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    manifest.push({ path, sha256: await sha256(content), size: content.length });
  }
  return manifest;
}

function filesForVersion(version) {
  const sourceFiles = new Map();
  for (const [path, content] of rawFiles) {
    const releasePath = path.endsWith('/release.json');
    const versionedPath = path.replace('/1.1.0/', `/${version}/`);
    sourceFiles.set(versionedPath, releasePath ? bytes(`{"id":"hello-world","version":"${version}"}\n`) : content);
  }
  return sourceFiles;
}

const keyA = await throwawayKey('octocat', owner);
const keyA2 = await throwawayKey('octocat', owner);
const keyB = await throwawayKey('other-pub', { login: 'other-pub', id: 71002 });
const unknownKey = await throwawayKey('unlisted-pub', { login: 'unlisted-pub', id: 71003 });
const unsafeAnchorKey = await throwawayKey('octocat', { login: '../octocat', id: 71004 });

const rawFiles = new Map([
  ['public-source.tar', bytes('tar\n')],
  ['release-receipt.json', bytes('{"status":"RELEASED"}\n')],
  ['publish-check.json', bytes('{"status":"PASS"}\n')],
  ['site/hello-world/1.1.0/release.json', bytes('{"id":"hello-world","version":"1.1.0"}\n')],
  ['site/hello-world/1.1.0/documents/CONTRACT.md', bytes('Public contract.\n')],
]);

const files = await manifestFor(rawFiles);

const baseStatement = {
  schemaVersion: 1,
  publisher: 'octocat',
  project: 'octocat/hello-world',
  version: '1.1.0',
  tag: 'v1.1.0',
  repository,
  publicCommit: '1'.repeat(40),
  publicTree: '2'.repeat(40),
  tagObject: '3'.repeat(40),
  files,
  issuedAt,
  keyId: keyA.keyId,
};
const basePayload = canonicalBytes(baseStatement);
const statementSha256 = await sha256(basePayload);
const good = await envelope(keyA, basePayload);
const signedFloor = { 'octocat/hello-world': '1.1.0' };
const testAnchors = {
  schemaVersion: 1,
  environment: 'test',
  serial: 1,
  legacyUnsigned: { 'never-enrolled/app': '0.1.0' },
  keys: [await anchor(keyA, { unsignedThrough: signedFloor })],
};
const otherPublisherAnchors = {
  ...copy(testAnchors),
  keys: [...copy(testAnchors.keys), await anchor(keyB)],
};
const successorAnchors = {
  ...copy(testAnchors),
  keys: [...copy(testAnchors.keys), await anchor(keyA2, { unsignedThrough: signedFloor })],
};
const productionAnchors = {
  schemaVersion: 1,
  environment: 'production',
  serial: 1,
  legacyUnsigned: {},
  keys: [],
};

function context(extra = {}) {
  return {
    environment: 'test',
    now,
    expect: {
      project: baseStatement.project,
      repository,
      tag: baseStatement.tag,
      publicCommit: baseStatement.publicCommit,
      publicTree: baseStatement.publicTree,
      tagObject: baseStatement.tagObject,
    },
    ...extra,
  };
}

function unsignedContext(project, version) {
  return {
    environment: 'test',
    now,
    expect: { project, version, tag: `v${version}` },
    unsigned: { project, version },
  };
}

async function resign(key, fields = {}) {
  const statement = { ...baseStatement, ...fields, keyId: key.keyId };
  return envelope(key, canonicalBytes(statement));
}

const vectors = [];
function add(name, envelopeValue, anchors, contextValue, expected) {
  vectors.push({
    name,
    envelope: envelopeValue === null || envelopeValue === false ? envelopeValue : b64(envelopeValue),
    anchors: copy(anchors),
    context: copy(contextValue),
    expected,
  });
}

const allFiles = filesAsBase64(rawFiles);
add('baseline synthetic signed bundle', good, testAnchors, context({ files: allFiles }), 'VERIFIED');

const asciiFiles = new Map(rawFiles);
asciiFiles.set('site/hello-world/1.1.0/documents/price + terms%.md', bytes('Public price and terms.\n'));
add('signed document path contains printable ASCII punctuation and space',
  await resign(keyA, { files: await manifestFor(asciiFiles) }), testAnchors,
  context({ files: filesAsBase64(asciiFiles) }), 'VERIFIED');
const uppercaseProject = 'octocat/Hello-World';
add('uppercase project and signed unsigned-through floor',
  await resign(keyA, { project: uppercaseProject }), {
    ...copy(testAnchors),
    keys: [await anchor(keyA, { unsignedThrough: { [uppercaseProject]: '1.1.0' } })],
  }, context({ expect: { ...context().expect, project: uppercaseProject }, files: allFiles }), 'VERIFIED');

for (const [name, path] of [
  ['flipped document digest', 'site/hello-world/1.1.0/documents/CONTRACT.md'],
  ['flipped release.json digest', 'site/hello-world/1.1.0/release.json'],
  ['flipped public source archive digest', 'public-source.tar'],
]) {
  const mutated = new Map(rawFiles);
  mutated.set(path, changed(mutated.get(path)));
  add(name, good, testAnchors, context({ files: filesAsBase64(mutated) }), 'DIGEST_MISMATCH');
}

add('changed payload with original signature', editEnvelope(good, value => {
  value.payload = b64(changed(decoded(value.payload), 40));
}), testAnchors, context(), 'SIGNATURE_INVALID');
add('changed signature bit', editEnvelope(good, value => {
  value.signatures[0].sig = b64(changed(decoded(value.signatures[0].sig), 5));
}), testAnchors, context(), 'SIGNATURE_INVALID');
add('changed statement keyId without resigning', editEnvelope(good, value => {
  const statement = JSON.parse(new TextDecoder().decode(decoded(value.payload)));
  statement.keyId = keyA2.keyId;
  value.payload = b64(canonicalBytes(statement));
}), testAnchors, context(), 'SIGNATURE_INVALID');
add('changed envelope keyId to an unenrolled id', editEnvelope(good, value => {
  const keyId = value.signatures[0].keyid;
  value.signatures[0].keyid = keyId.slice(0, -1) + (keyId.endsWith('0') ? '1' : '0');
}), testAnchors, context(), 'KEY_UNKNOWN');
add('validly signed by an unenrolled key', await resign(unknownKey), testAnchors, context(), 'KEY_UNKNOWN');
add('re-signed by another enrolled publisher', await resign(keyB), otherPublisherAnchors, context(), 'PUBLISHER_MISMATCH');

const canonicalStatement = canonical(baseStatement);
const reordered = '{' + Object.keys(baseStatement).sort().reverse()
  .map(key => `${JSON.stringify(key)}:${canonical(baseStatement[key])}`).join(',') + '}';
const escaped = canonicalStatement.replace('"octocat/hello-world"', '"octocat/\\u0068ello-world"');
const pretty = JSON.stringify(baseStatement, null, 2);
const duplicate = canonicalStatement.replace('{', '{"version":"9.9.9",');
for (const [name, payload] of [
  ['reordered statement keys', encoder.encode(reordered)],
  ['escaped ASCII string', encoder.encode(escaped)],
  ['pretty-printed statement', encoder.encode(pretty)],
  ['duplicate statement key', encoder.encode(duplicate)],
]) {
  add(name, await envelope(keyA, payload), testAnchors, context(), 'STATEMENT_NOT_CANONICAL');
}
add('NFD Unicode project name', await resign(keyA, { project: 'octocat/he\u0301llo-world' }), testAnchors, context(), 'STATEMENT_INVALID');
add('invalid statement schema version', await resign(keyA, { schemaVersion: 2 }), testAnchors, context(), 'STATEMENT_INVALID');

const olderFiles = await manifestFor(filesForVersion('1.0.0'));
add('older version after a newer admitted version', await resign(keyA, {
  version: '1.0.0',
  tag: 'v1.0.0',
  files: olderFiles,
}), testAnchors, { environment: 'test', now, highest: { version: '1.1.0', statementSha256 } }, 'VERSION_ROLLBACK');
add('same version with a different statement digest', await resign(keyA, { issuedAt: '2026-10-12T23:59:59Z' }),
  testAnchors, { environment: 'test', now, highest: { version: '1.1.0', statementSha256 } }, 'VERSION_REUSED');
add('identical statement replay is accepted', good, testAnchors,
  { environment: 'test', now, highest: { version: '1.1.0', statementSha256 } }, 'VERIFIED');

add('test key presented to a production verifier', good, productionAnchors,
  { environment: 'production', now }, 'KEY_TEST_REFUSED');
add('production anchors list a test key', null, {
  ...copy(productionAnchors),
  keys: [await anchor(keyA, { unsignedThrough: signedFloor })],
}, { environment: 'production' }, 'ANCHORS_INVALID');
add('enrolment proof signed by a different key', null, withAnchor(testAnchors, keyA.keyId, {
  enrolment: JSON.parse(new TextDecoder().decode(await enrolment(keyA, { unsignedThrough: signedFloor, signer: keyB }))),
}), { environment: 'test' }, 'ANCHORS_INVALID');
add('anchor environment differs from verifier', null, {
  ...copy(testAnchors),
  environment: 'production',
}, { environment: 'test' }, 'ANCHORS_INVALID');
add('unsafe GitHub owner in a validly signed anchor claim', null, {
  ...copy(testAnchors),
  keys: [...copy(testAnchors.keys), await anchor(unsafeAnchorKey)],
}, { environment: 'test' }, 'ANCHORS_INVALID');
add('legacy floor overlaps an enrolled publisher', null, {
  ...copy(testAnchors),
  legacyUnsigned: { 'octocat/hello-world': '9.9.9' },
}, { environment: 'test' }, 'ANCHORS_INVALID');
add('anchor serial is equal to the last accepted serial', null, testAnchors,
  { environment: 'test', minimumSerial: 1 }, 'ANCHORS_STALE');

add('compromised key without a reviewed keep digest', good, withAnchor(testAnchors, keyA.keyId, {
  status: 'compromised', compromisedAt: issuedAt, keepStatements: [],
}), context(), 'KEY_REVOKED');
add('compromised key with a reviewed keep digest', good, withAnchor(testAnchors, keyA.keyId, {
  status: 'compromised', compromisedAt: issuedAt, keepStatements: [statementSha256],
}), context(), 'VERIFIED');
add('retired key verifies statement from before retirement', good, withAnchor(testAnchors, keyA.keyId, {
  status: 'retired', retiredAt: '2026-10-13T00:00:01Z',
}), context(), 'VERIFIED');
add('retired key refuses statement at retirement time', good, withAnchor(testAnchors, keyA.keyId, {
  status: 'retired', retiredAt: issuedAt,
}), context(), 'KEY_RETIRED');
const successorSourceFiles = filesForVersion('1.2.0');
const successorFiles = await manifestFor(successorSourceFiles);
add('successor key signs the next release', await resign(keyA2, {
  version: '1.2.0',
  tag: 'v1.2.0',
  files: successorFiles,
}), withAnchor(successorAnchors, keyA.keyId, { status: 'retired', retiredAt: issuedAt }), context({
  expect: { ...context().expect, tag: 'v1.2.0' },
  files: filesAsBase64(successorSourceFiles),
}), 'VERIFIED');
add('statement issued before key validity starts', await resign(keyA, { issuedAt: '2026-09-30T23:59:59Z' }), testAnchors, context(), 'KEY_OUTSIDE_VALIDITY');
add('statement issued one year in the future', await resign(keyA, { issuedAt: '2027-10-13T00:00:00Z' }), testAnchors, context(), 'ISSUED_IN_FUTURE');

add('statement tag differs from expected release', good, testAnchors,
  context({ expect: { ...context().expect, tag: 'v1.1.1' } }), 'SUBJECT_MISMATCH');
const missingFiles = { ...allFiles };
delete missingFiles['site/hello-world/1.1.0/documents/CONTRACT.md'];
add('declared document missing from bundle', good, testAnchors, context({ files: missingFiles }), 'FILE_MISSING');
add('bundle contains an undeclared document', good, testAnchors, context({ files: {
  ...allFiles,
  'site/hello-world/1.1.0/documents/EXTRA.md': b64(bytes('extra\n')),
} }), 'FILE_UNDECLARED');
add('bundle contains an unsafe path', good, testAnchors, context({ files: {
  ...allFiles,
  'site/hello-world/1.1.0/documents/../escape.md': b64(bytes('unsafe\n')),
} }), 'PATH_UNSAFE');

add('malformed DSSE envelope', bytes('not an envelope'), testAnchors, context(), 'ENVELOPE_INVALID');
add('envelope exceeds the 64 KiB limit', new Uint8Array(65537).fill(0x20), testAnchors, context(), 'INPUT_TOO_LARGE');
add('unsigned release inside the enrolled publisher floor', false, testAnchors,
  unsignedContext('octocat/hello-world', '1.1.0'), 'UNSIGNED_LEGACY');
add('stripped signature above the enrolled publisher floor', false, testAnchors,
  unsignedContext('octocat/hello-world', '1.2.0'), 'SIGNATURE_MISSING');
add('unsigned release inside the legacy floor for an unenrolled publisher', false, testAnchors,
  unsignedContext('never-enrolled/app', '0.1.0'), 'UNSIGNED_LEGACY');
add('unsigned release outside every legacy floor', false, testAnchors,
  unsignedContext('new-community/app', '1.0.0'), 'SIGNATURE_MISSING');

const output = new URL('./release-signature-vectors.json', import.meta.url);
writeFileSync(output, JSON.stringify(vectors, null, 2) + '\n');
console.log(`Wrote ${vectors.length} public release-signature vectors.`);
await import('./publisher-projects.mjs');
