// Shared release authentication: dependency-free, with one WebCrypto code path.
export const PAYLOAD_TYPE = 'application/vnd.runeditrun.release-statement.v1+json';
export const ENROLMENT_TYPE = 'application/vnd.runeditrun.key-enrolment.v1+json';
export const LIMITS = Object.freeze({ envelopeBytes: 65536, files: 256, fileBytes: 1073741824, projectsPerKey: 1024 });
const encoder = new TextEncoder();
const trusted = new WeakMap();
const codes = new Set(('SIGNATURE_MISSING INPUT_TOO_LARGE ENVELOPE_INVALID KEY_TEST_REFUSED KEY_UNKNOWN SIGNATURE_INVALID STATEMENT_NOT_CANONICAL STATEMENT_INVALID PUBLISHER_MISMATCH KEY_OUTSIDE_VALIDITY KEY_RETIRED KEY_REVOKED ISSUED_IN_FUTURE SUBJECT_MISMATCH FILE_MISSING FILE_UNDECLARED DIGEST_MISMATCH PATH_UNSAFE VERSION_ROLLBACK VERSION_REUSED ANCHORS_INVALID ANCHORS_STALE').split(' '));
export class Refusal extends Error {
  constructor(code) { const safe = codes.has(code) ? code : 'STATEMENT_INVALID'; super(safe); this.name = 'Refusal'; this.code = safe; }
}
const refuse = code => { throw new Refusal(code); };
function sanitized(error, code) { refuse(error instanceof Refusal && codes.has(error.code) ? error.code : code); }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
function shape(value, required, optional = []) {
  if (!record(value)) return false;
  const keys = Reflect.ownKeys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => typeof key === 'string'
    && (required.includes(key) || optional.includes(key)) && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined);
}
function ascii(value) { return typeof value === 'string' && value.length > 0 && !/[^\x20-\x7e]/.test(value); }
const namespace = /^[a-z0-9][a-z0-9-]{0,38}$/;
// Names are literal printable ASCII components, not URLs. Do not case-fold them.
export function validRelativePath(path) {
  return ascii(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function validProject(value) {
  if (!validRelativePath(value)) return false;
  const parts = value.split('/');
  return parts.length === 2 && namespace.test(parts[0]);
}
const repositoryPattern = /^https:\/\/github\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const hex40 = /^[a-f0-9]{40}$/, hex64 = /^[a-f0-9]{64}$/;
const keyPattern = /^(rer|test)-ed25519-[a-f0-9]{32}$/;
function version(value) {
  return matches(value, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
    && value.split('.').every(part => Number.isSafeInteger(Number(part)));
}
function instant(value) {
  return matches(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z');
}
function bytes(value, code) { if (!(value instanceof Uint8Array)) refuse(code); return value; }
function serialize(value, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if ((!Array.isArray(value) && !record(value)) || ancestors.has(value)) refuse('STATEMENT_INVALID');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) refuse('STATEMENT_INVALID');
    result = '[' + Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor)) refuse('STATEMENT_INVALID');
      return serialize(descriptor.value, ancestors);
    }).join(',') + ']';
  } else {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) refuse('STATEMENT_INVALID');
    result = '{' + keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !('value' in descriptor)) refuse('STATEMENT_INVALID');
      return JSON.stringify(key) + ':' + serialize(descriptor.value, ancestors);
    }).join(',') + '}';
  }
  ancestors.delete(value);
  return result;
}
export function canonical(value) {
  try { return serialize(value, new Set()); } catch (error) { sanitized(error, 'STATEMENT_INVALID'); }
}
export const canonicalBytes = value => encoder.encode(canonical(value));
export function pae(type, body) {
  try {
    if (typeof type !== 'string') refuse('ENVELOPE_INVALID');
    bytes(body, 'ENVELOPE_INVALID');
    const prefix = encoder.encode(`DSSEv1 ${encoder.encode(type).length} ${type} ${body.length} `);
    const result = new Uint8Array(prefix.length + body.length);
    result.set(prefix); result.set(body, prefix.length); return result;
  } catch (error) { sanitized(error, 'ENVELOPE_INVALID'); }
}
export function b64(value) {
  try { bytes(value, 'ENVELOPE_INVALID'); let text = ''; for (const byte of value) text += String.fromCharCode(byte); return btoa(text); }
  catch (error) { sanitized(error, 'ENVELOPE_INVALID'); }
}
function unb64(value) {
  if (!matches(value, /^[A-Za-z0-9+/]*={0,2}$/)) refuse('ENVELOPE_INVALID');
  let result;
  try { result = Uint8Array.from(atob(value), char => char.charCodeAt(0)); } catch { refuse('ENVELOPE_INVALID'); }
  if (b64(result) !== value) refuse('ENVELOPE_INVALID');
  return result;
}
export async function sha256(value) {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value, 'STATEMENT_INVALID')))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  catch (error) { sanitized(error, 'STATEMENT_INVALID'); }
}
export async function keyIdFor(scope, raw) {
  if (!['rer', 'test'].includes(scope) || !(raw instanceof Uint8Array) || raw.length !== 32) refuse('ANCHORS_INVALID');
  return `${scope}-ed25519-${(await sha256(raw)).slice(0, 32)}`;
}
export function compareVersion(a, b) {
  if (!version(a) || !version(b)) refuse('STATEMENT_INVALID');
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
const requiredFiles = ['public-source.tar', 'release-receipt.json', 'publish-check.json'];
const filePattern = /^(public-source\.tar|release-receipt\.json|publish-check\.json|site\/[a-z0-9]+(?:-[a-z0-9]+)*\/[^/]+\/(?:release\.json|documents\/.+|assets\/seeds\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+))$/;
function safePath(path) {
  return validRelativePath(path) && matches(path, filePattern);
}
// V1 anchors retain their original namespace/schema refusal. V2 separates
// project grammar from the signing key's reviewed authority below.
export function validateStatement(s, anchorsVersion = 1) {
  try {
    if (!shape(s, ['schemaVersion', 'publisher', 'project', 'version', 'tag', 'repository', 'publicCommit', 'publicTree', 'tagObject', 'files', 'issuedAt', 'keyId'])
      || s.schemaVersion !== 1 || !matches(s.publisher, namespace) || !validProject(s.project)
      || (anchorsVersion === 1 && !s.project.startsWith(s.publisher + '/')) || !version(s.version) || s.tag !== 'v' + s.version
      || !matches(s.repository, repositoryPattern) || ['.', '..'].includes(s.repository.split('/')[4])
      || !matches(s.publicCommit, hex40) || !matches(s.publicTree, hex40) || !matches(s.tagObject, hex40)
      || !instant(s.issuedAt) || !matches(s.keyId, keyPattern) || !Array.isArray(s.files)) refuse('STATEMENT_INVALID');
    if (s.files.length > LIMITS.files) refuse('INPUT_TOO_LARGE');
    if (s.files.length < 4) refuse('STATEMENT_INVALID');
    let previous = '';
    for (const f of s.files) {
      if (!shape(f, ['path', 'sha256', 'size']) || !safePath(f.path) || !matches(f.sha256, hex64)
        || !Number.isSafeInteger(f.size) || f.size < 0 || f.path <= previous) refuse('STATEMENT_INVALID');
      if (f.size > LIMITS.fileBytes) refuse('INPUT_TOO_LARGE');
      previous = f.path;
    }
    const releases = s.files.filter(f => /^site\/[^/]+\/[^/]+\/release\.json$/.test(f.path));
    if (releases.length !== 1 || releases[0].path.split('/')[2] !== s.version) refuse('STATEMENT_INVALID');
    const prefix = releases[0].path.slice(0, -'release.json'.length);
    if (requiredFiles.some(path => !s.files.some(f => f.path === path))
      || s.files.some(f => f.path.startsWith('site/') && (!f.path.startsWith(prefix)
        || (f.path.startsWith(prefix + 'assets/') && !f.path.startsWith(prefix + `assets/seeds/${releases[0].path.split('/')[1]}/`))))) refuse('STATEMENT_INVALID');
  } catch (error) { sanitized(error, 'STATEMENT_INVALID'); }
}
function parseJSON(value, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value)); } catch { refuse(code); }
}
function envelopeParts(envelope, type) {
  if (!shape(envelope, ['payloadType', 'payload', 'signatures']) || envelope.payloadType !== type
    || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1
    || !shape(envelope.signatures[0], ['keyid', 'sig']) || !matches(envelope.signatures[0].keyid, keyPattern)) refuse('ENVELOPE_INVALID');
  const payload = unb64(envelope.payload), signature = unb64(envelope.signatures[0].sig);
  if (signature.length !== 64) refuse('ENVELOPE_INVALID');
  return { keyid: envelope.signatures[0].keyid, payload, signature };
}
function canonicalPayload(payload) {
  const statement = parseJSON(payload, 'STATEMENT_NOT_CANONICAL');
  let again;
  try { again = canonicalBytes(statement); } catch { refuse('STATEMENT_NOT_CANONICAL'); }
  if (again.length !== payload.length || again.some((byte, index) => byte !== payload[index])) refuse('STATEMENT_NOT_CANONICAL');
  return statement;
}
async function checkSignature(key, type, payload, signature) {
  try { if (await crypto.subtle.verify('Ed25519', key, signature, pae(type, payload))) return; } catch { /* Sanitized below. */ }
  refuse('SIGNATURE_INVALID');
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function floors(value, publisher) {
  return record(value) && Object.entries(value).every(([project, maximum]) => validProject(project)
    && (!publisher || project.startsWith(publisher + '/')) && version(maximum));
}
// Returns a separate immutable snapshot. Only this module can create trusted anchors.
// minimumSerial is the last accepted serial: equal and older imports are stale.
export async function loadAnchors(raw, environment = 'production', options = {}) {
  try {
    if (!['production', 'test'].includes(environment) || !shape(options, [], ['minimumSerial'])
      || (Object.hasOwn(options, 'minimumSerial') && (!Number.isSafeInteger(options.minimumSerial) || options.minimumSerial < 0))) refuse('ANCHORS_INVALID');
    const anchors = raw instanceof Uint8Array ? parseJSON(raw, 'ANCHORS_INVALID')
      : typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(canonical(raw));
    if (!shape(anchors, ['schemaVersion', 'environment', 'serial', 'legacyUnsigned', 'keys']) || ![1, 2].includes(anchors.schemaVersion)
      || anchors.environment !== environment || !Number.isSafeInteger(anchors.serial) || anchors.serial < 1
      || !Array.isArray(anchors.keys) || !floors(anchors.legacyUnsigned)) refuse('ANCHORS_INVALID');
    const lookup = new Map(), owners = new Map();
    for (const k of anchors.keys) {
      const projectFields = anchors.schemaVersion === 2 ? ['projects'] : [];
      if (!shape(k, ['keyId', 'publicKey', 'publisher', 'githubOwner', 'notBefore', 'notAfter', 'status', 'enrolment', 'review', ...projectFields], ['retiredAt', 'compromisedAt', 'keepStatements'])
        || !matches(k.keyId, keyPattern) || lookup.has(k.keyId) || !matches(k.publisher, namespace)
        || !shape(k.githubOwner, ['login', 'id']) || !matches(k.githubOwner.login, namespace)
        || !Number.isSafeInteger(k.githubOwner.id) || k.githubOwner.id <= 0 || !ascii(k.review)
        || !instant(k.notBefore) || !instant(k.notAfter) || k.notBefore >= k.notAfter
        || !['active', 'retired', 'compromised'].includes(k.status)) refuse('ANCHORS_INVALID');
      if (anchors.schemaVersion === 2 && (!Array.isArray(k.projects) || k.projects.length < 1
        || k.projects.length > LIMITS.projectsPerKey || !k.projects.every(validProject)
        || new Set(k.projects).size !== k.projects.length)) refuse('ANCHORS_INVALID');
      const maximum = new Date(k.notBefore); maximum.setUTCFullYear(maximum.getUTCFullYear() + 2);
      if (Date.parse(k.notAfter) > maximum.getTime()) refuse('ANCHORS_INVALID');
      if ((k.status === 'retired' && !Object.hasOwn(k, 'retiredAt'))
        || (k.status === 'active' && Object.hasOwn(k, 'retiredAt'))
        || (k.status === 'compromised') !== Object.hasOwn(k, 'compromisedAt')
        || (Object.hasOwn(k, 'retiredAt') && !instant(k.retiredAt))
        || (Object.hasOwn(k, 'compromisedAt') && !instant(k.compromisedAt))
        || (Object.hasOwn(k, 'keepStatements') && (k.status !== 'compromised' || !Array.isArray(k.keepStatements)
          || k.keepStatements.some(hash => !matches(hash, hex64)) || new Set(k.keepStatements).size !== k.keepStatements.length))) refuse('ANCHORS_INVALID');
      const owner = canonical(k.githubOwner);
      if (owners.has(k.publisher) && owners.get(k.publisher) !== owner) refuse('ANCHORS_INVALID');
      owners.set(k.publisher, owner);
      const scope = k.keyId.split('-')[0], publicBytes = unb64(k.publicKey);
      if ((environment === 'production' && scope !== 'rer') || publicBytes.length !== 32
        || k.keyId !== await keyIdFor(scope, publicBytes)) refuse('ANCHORS_INVALID');
      if (canonicalBytes(k.enrolment).length > LIMITS.envelopeBytes) refuse('ANCHORS_INVALID');
      const { keyid, payload, signature } = envelopeParts(k.enrolment, ENROLMENT_TYPE);
      if (keyid !== k.keyId) refuse('ANCHORS_INVALID');
      const publicKey = await crypto.subtle.importKey('raw', publicBytes, 'Ed25519', false, ['verify']);
      await checkSignature(publicKey, ENROLMENT_TYPE, payload, signature);
      const claim = canonicalPayload(payload);
      const claimFields = ['schemaVersion', 'keyId', 'publicKey', 'publisher', 'githubOwner', 'notBefore', 'notAfter', 'issuedAt', 'unsignedThrough'];
      if (!shape(claim, claimFields) || claim.schemaVersion !== 1 || !instant(claim.issuedAt) || !floors(claim.unsignedThrough, k.publisher)
        || ['keyId', 'publicKey', 'publisher', 'notBefore', 'notAfter'].some(field => claim[field] !== k[field])
        || canonical(claim.githubOwner) !== owner) refuse('ANCHORS_INVALID');
      k.unsignedThrough = claim.unsignedThrough;
      lookup.set(k.keyId, { anchor: k, publicKey });
    }
    if (Object.keys(anchors.legacyUnsigned).some(project => owners.has(project.split('/')[0]))) refuse('ANCHORS_INVALID');
    if (options.minimumSerial !== undefined && anchors.serial <= options.minimumSerial) refuse('ANCHORS_STALE');
    freeze(anchors); trusted.set(anchors, lookup); return anchors;
  } catch (error) { if (error instanceof Refusal && error.code === 'ANCHORS_STALE') throw error; refuse('ANCHORS_INVALID'); }
}
function contextRecord(context) {
  if (!record(context)) refuse('STATEMENT_INVALID');
  const allowed = ['environment', 'now', 'expect', 'files', 'checkPaths', 'highest', 'unsigned'];
  if (Reflect.ownKeys(context).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !('value' in Object.getOwnPropertyDescriptor(context, key)))) refuse('STATEMENT_INVALID');
  return { ...context };
}
function expectedSubject(expect, statement) {
  if (expect === undefined) return;
  const fields = ['publisher', 'project', 'version', 'repository', 'tag', 'publicCommit', 'publicTree', 'tagObject'];
  const valid = (field, value) => field === 'publisher' ? matches(value, namespace)
    : field === 'project' ? validProject(value) : field === 'version' ? version(value)
      : field === 'repository' ? matches(value, repositoryPattern) : field === 'tag' ? typeof value === 'string' && value.startsWith('v') && version(value.slice(1))
        : matches(value, hex40);
  if (!shape(expect, [], fields) || Object.entries(expect).some(([field, value]) => !valid(field, value)
    || (statement !== undefined && statement[field] !== value))) refuse('SUBJECT_MISMATCH');
}
function versionOrder(highest, versionValue, digest) {
  if (highest === undefined) return;
  if (!shape(highest, ['version', 'statementSha256']) || !version(highest.version) || !matches(highest.statementSha256, hex64)) refuse('STATEMENT_INVALID');
  const order = compareVersion(versionValue, highest.version);
  if (order < 0) refuse('VERSION_ROLLBACK');
  if (order === 0 && digest !== highest.statementSha256) refuse('VERSION_REUSED');
}
async function checkFiles(statement, context) {
  if (context.checkPaths !== undefined && typeof context.checkPaths !== 'function') refuse('PATH_UNSAFE');
  if (context.files === undefined) {
    return;
  }
  if (!(context.files instanceof Map)) refuse('PATH_UNSAFE');
  if (context.files.size > LIMITS.files) refuse('INPUT_TOO_LARGE');
  const files = new Map(context.files), selected = new Map();
  const select = path => {
    if (!selected.has(path)) {
      let answer;
      try { answer = context.checkPaths === undefined ? true : context.checkPaths(path); } catch { refuse('PATH_UNSAFE'); }
      if (typeof answer !== 'boolean') refuse('PATH_UNSAFE');
      selected.set(path, answer);
    }
    return selected.get(path);
  };
  for (const [path, value] of files) {
    if (!safePath(path) || !(value instanceof Uint8Array)) refuse('PATH_UNSAFE');
    if (value.byteLength > LIMITS.fileBytes) refuse('INPUT_TOO_LARGE');
  }
  for (const entry of statement.files) {
    if (!select(entry.path)) continue;
    if (!files.has(entry.path)) refuse('FILE_MISSING');
    const value = files.get(entry.path);
    if (value.byteLength !== entry.size || await sha256(value) !== entry.sha256) refuse('DIGEST_MISMATCH');
  }
  const declared = new Set(statement.files.map(entry => entry.path));
  for (const path of files.keys()) if (select(path) && !declared.has(path)) refuse('FILE_UNDECLARED');
}
// Context omits files for service admission, or selects site/ paths for a site
// build. Base passes all artifact files. Input failures never expose contents.
export async function verifyRelease(envelopeBytes, loadedAnchors, input = {}) {
  try {
    // Release failures follow the spec's order: size, envelope, scope, lookup,
    // signature, canonical bytes, schema, identity, time, subject, files, version.
    let parts;
    if (envelopeBytes !== null) {
      bytes(envelopeBytes, 'ENVELOPE_INVALID');
      if (envelopeBytes.byteLength > LIMITS.envelopeBytes) refuse('INPUT_TOO_LARGE');
      parts = envelopeParts(parseJSON(envelopeBytes, 'ENVELOPE_INVALID'), PAYLOAD_TYPE);
    }
    const context = contextRecord(input);
    const environment = context.environment === undefined ? 'production' : context.environment;
    if (!['production', 'test'].includes(environment)) refuse('ANCHORS_INVALID');
    if (parts && environment === 'production' && parts.keyid.startsWith('test-')) refuse('KEY_TEST_REFUSED');
    if (!trusted.has(loadedAnchors) || loadedAnchors.environment !== environment) refuse('ANCHORS_INVALID');
    if (!parts) {
      const unsigned = context.unsigned;
      if (unsigned === undefined) refuse('SIGNATURE_MISSING');
      if (!shape(unsigned, ['project', 'version']) || !validProject(unsigned.project) || !version(unsigned.version)) refuse('STATEMENT_INVALID');
      // A legacy floor authenticates no bytes or Git subjects. Callers retain
      // their existing pins; these optional inputs still must be well formed.
      expectedSubject(context.expect);
      if (context.files !== undefined || context.checkPaths !== undefined) {
        // Bytes are not authenticated by a legacy floor, but malformed inputs still fail closed.
        if ((context.files !== undefined && !(context.files instanceof Map)) || (context.checkPaths !== undefined && typeof context.checkPaths !== 'function')) refuse('PATH_UNSAFE');
        if (context.files?.size > LIMITS.files) refuse('INPUT_TOO_LARGE');
        for (const [path, value] of context.files ?? []) {
          if (!safePath(path) || !(value instanceof Uint8Array)) refuse('PATH_UNSAFE');
          if (value.byteLength > LIMITS.fileBytes) refuse('INPUT_TOO_LARGE');
        }
      }
      if (context.now !== undefined && (!Number.isSafeInteger(context.now) || Math.abs(context.now) > 8640000000000000)) refuse('STATEMENT_INVALID');
      const keys = loadedAnchors.keys.filter(key => key.publisher === unsigned.project.split('/')[0]);
      const ceilings = keys.length ? keys.map(key => key.unsignedThrough[unsigned.project]) : [loadedAnchors.legacyUnsigned[unsigned.project]];
      if (!ceilings.some(ceiling => ceiling !== undefined && compareVersion(unsigned.version, ceiling) <= 0)) refuse('SIGNATURE_MISSING');
      versionOrder(context.highest, unsigned.version, undefined);
      return { verdict: 'UNSIGNED_LEGACY', project: unsigned.project, version: unsigned.version };
    }
    const found = trusted.get(loadedAnchors).get(parts.keyid);
    if (!found) refuse('KEY_UNKNOWN');
    await checkSignature(found.publicKey, PAYLOAD_TYPE, parts.payload, parts.signature);
    const statement = canonicalPayload(parts.payload);
    validateStatement(statement, loadedAnchors.schemaVersion);
    if (statement.keyId !== parts.keyid) refuse('STATEMENT_INVALID');
    const anchor = found.anchor;
    if (statement.publisher !== anchor.publisher || statement.repository.split('/')[3] !== anchor.githubOwner.login
      || (loadedAnchors.schemaVersion === 2 && !anchor.projects.includes(statement.project))) refuse('PUBLISHER_MISMATCH');
    const statementSha256 = await sha256(parts.payload);
    const now = context.now === undefined ? Date.now() : context.now;
    if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) refuse('STATEMENT_INVALID');
    const issued = Date.parse(statement.issuedAt);
    if (issued > now + 300000) refuse('ISSUED_IN_FUTURE');
    if (issued < Date.parse(anchor.notBefore) || issued >= Date.parse(anchor.notAfter)) refuse('KEY_OUTSIDE_VALIDITY');
    if (anchor.status === 'retired' && issued >= Date.parse(anchor.retiredAt)) refuse('KEY_RETIRED');
    if (anchor.status === 'compromised' && !(anchor.keepStatements ?? []).includes(statementSha256)) refuse('KEY_REVOKED');
    if (context.unsigned !== undefined && (!shape(context.unsigned, ['project', 'version'])
      || context.unsigned.project !== statement.project || context.unsigned.version !== statement.version)) refuse('SUBJECT_MISMATCH');
    expectedSubject(context.expect, statement);
    await checkFiles(statement, context);
    versionOrder(context.highest, statement.version, statementSha256);
    return { verdict: 'VERIFIED', statementSha256, keyId: parts.keyid, publisher: statement.publisher, project: statement.project, version: statement.version };
  } catch (error) { sanitized(error, 'STATEMENT_INVALID'); }
}
