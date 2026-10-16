import { createHash } from 'node:crypto';
import { writeBody, readBody, randomId, checksumNames, verifyChecksums } from './r2-store.mjs';

// R2 semantics over the visitor's own storage: one namespace per binding,
// conditional and ranged reads, delimited listing and multipart uploads.
const failure = (method, message, code) => Object.assign(new Error(`${method}: ${message} (${code})`), { code });
const json = value => JSON.stringify(value ?? {});
function httpMetadata(text) {
  const value = JSON.parse(text);
  if (value.cacheExpiry) value.cacheExpiry = new Date(value.cacheExpiry);
  return value;
}
const buffer = hex => Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
function metadata(row, include = ['httpMetadata', 'customMetadata']) {
  return { key: row.key, version: row.version, size: row.size, etag: row.etag, httpEtag: `"${row.etag}"`, uploaded: new Date(row.uploaded),
    httpMetadata: include.includes('httpMetadata') ? httpMetadata(row.http) : {}, customMetadata: include.includes('customMetadata') ? JSON.parse(row.custom) : {},
    checksums: Object.fromEntries(Object.entries(JSON.parse(row.checksums)).map(([name, hex]) => [name, buffer(hex)])), storageClass: row.class };
}

const etags = value => [].concat(value).flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean)
  .map(item => item === '*' ? { wildcard: true } : { weak: item.startsWith('W/'), value: item.replace(/^W\//, '').replace(/^"(.*)"$/, '$1') });
const includes = (list, etag, weak) => etags(list).some(item => item.wildcard || (item.value === etag && (weak || !item.weak)));
// The precedence of If-Match over If-Unmodified-Since (and so on) follows R2.
export function satisfied(condition, row) {
  if (!condition) return true;
  if (!row) return condition.etagMatches === undefined && condition.uploadedAfter === undefined;
  const truncate = condition.secondsGranularity ? time => Math.floor(time / 1000) * 1000 : time => time, uploaded = truncate(row.uploaded);
  const match = condition.etagMatches === undefined || includes(condition.etagMatches, row.etag, false);
  const noneMatch = condition.etagDoesNotMatch === undefined || !includes(condition.etagDoesNotMatch, row.etag, true);
  const after = condition.uploadedAfter === undefined || truncate(new Date(condition.uploadedAfter).getTime()) < uploaded || (condition.etagDoesNotMatch !== undefined && noneMatch);
  const before = condition.uploadedBefore === undefined || uploaded < truncate(new Date(condition.uploadedBefore).getTime()) || (condition.etagMatches !== undefined && match);
  return match && noneMatch && after && before;
}
function range(value, size) {
  if (!value) return null;
  let { offset, length, suffix } = value;
  if (value.header !== undefined) {
    const found = /^bytes=(\d*)-(\d*)$/.exec(String(value.header).trim());
    if (!found || (!found[1] && !found[2])) return null;
    if (!found[1]) suffix = Number(found[2]);
    else { offset = Number(found[1]); if (found[2]) length = Number(found[2]) - offset + 1; }
  }
  if (suffix !== undefined) {
    if (suffix <= 0) throw failure('get', 'The requested range is not satisfiable', 10039);
    suffix = Math.min(suffix, size); offset = size - suffix; length = suffix;
  }
  offset ??= 0; length ??= size - offset;
  if (offset < 0 || offset > size || length <= 0) throw failure('get', 'The requested range is not satisfiable', 10039);
  return { offset, length: Math.min(length, size - offset) };
}
const cancel = body => body instanceof ReadableStream ? body.cancel().catch(() => {}) : undefined;
// Swaps the object row to a written version; run inside a transaction.
function save(db, binding, key, written, fields) {
  const previous = db.object(binding, key);
  if (previous) db.drop(previous.version);
  db.sql.exec('INSERT OR REPLACE INTO rer_r2_objects(binding, key, version, size, etag, uploaded, http, custom, checksums, class) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    binding, key, written.version, written.size, fields.etag, Date.now(), json(fields.httpMetadata), json(fields.customMetadata), json(fields.checksums), fields.storageClass ?? 'Standard');
  return metadata(db.object(binding, key));
}

async function put(db, binding, key, body, options = {}) {
  const current = db.object(binding, key);
  if (!satisfied(options.onlyIf, current)) { await cancel(body); return null; }
  const written = await writeBody(db, 'put', body, { hashes: checksumNames(options), replaces: current?.size ?? 0 });
  try { verifyChecksums('put', options, written.sums); } catch (error) { db.drop(written.version); throw error; }
  // The condition is checked again against whatever is current once the body is in.
  const saved = db.transaction(() => satisfied(options.onlyIf, db.object(binding, key))
    ? save(db, binding, key, written, { ...options, etag: written.sums.md5, checksums: written.sums }) : null);
  if (!saved) db.drop(written.version);
  return saved;
}
function get(db, binding, key, options = {}) {
  const row = db.object(binding, key);
  if (!row) return null;
  if (!satisfied(options.onlyIf, row)) return metadata(row);
  const part = range(options.range, row.size);
  return { ...metadata(row), ...(part ? { range: part } : {}), body: readBody(db, row.version, part?.offset ?? 0, part?.length ?? row.size) };
}
function remove(db, binding, keys) {
  db.transaction(() => {
    for (const key of [].concat(keys).map(String)) {
      const row = db.object(binding, key);
      if (!row) continue;
      db.drop(row.version);
      db.sql.exec('DELETE FROM rer_r2_objects WHERE binding = ? AND key = ?', binding, key);
    }
  });
}
function list(db, binding, options = {}) {
  const prefix = String(options.prefix ?? ''), include = options.include ?? [], delimiter = options.delimiter || undefined;
  let limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw failure('list', 'MaxKeys params must be positive integer <= 1000.', 10022);
  if (include.length) limit = Math.min(limit, 100);
  let after = options.startAfter;
  if (options.cursor) { const cursor = Buffer.from(options.cursor, 'base64url').toString('utf8'); if (after === undefined || cursor > after) after = cursor; }
  const filter = 'binding = ?1 AND substr(key, 1, length(?2)) = ?2 AND (?3 IS NULL OR key > ?3)';
  // As in R2, each delimited prefix counts once toward the limit, and the
  // cursor skips past the last key it covers.
  const rows = delimiter
    ? db.rows(`SELECT *, max(key) AS last, iif(instr(substr(key, length(?2) + 1), ?5), substr(key, 1, length(?2) + instr(substr(key, length(?2) + 1), ?5) + length(?5) - 1), NULL) AS grouped,
        iif(instr(substr(key, length(?2) + 1), ?5), 'p:' || substr(key, 1, length(?2) + instr(substr(key, length(?2) + 1), ?5) + length(?5) - 1), 'k:' || key) AS item
        FROM rer_r2_objects WHERE ${filter} GROUP BY item ORDER BY last LIMIT ?4`, binding, prefix, after ?? null, limit + 1, delimiter)
    : db.rows(`SELECT *, key AS last, NULL AS grouped FROM rer_r2_objects WHERE ${filter} ORDER BY key LIMIT ?4`, binding, prefix, after ?? null, limit + 1);
  const truncated = rows.length > limit, page = rows.slice(0, limit);
  const objects = [], delimitedPrefixes = [];
  for (const row of page) {
    if (row.grouped !== null) delimitedPrefixes.push(row.grouped);
    else objects.push(metadata({ ...row, key: row.last }, include));
  }
  return { objects, truncated, ...(truncated ? { cursor: Buffer.from(page.at(-1).last, 'utf8').toString('base64url') } : {}), delimitedPrefixes };
}

const upload = (db, method, binding, key, id) => {
  const row = db.rows('SELECT * FROM rer_r2_uploads WHERE id = ? AND binding = ? AND key = ?', String(id), binding, key)[0];
  if (!row) throw failure(method, 'The specified multipart upload does not exist.', 10024);
  return row;
};
function createMultipartUpload(db, binding, key, options = {}) {
  const id = randomId() + randomId();
  db.sql.exec('INSERT INTO rer_r2_uploads(id, binding, key, options) VALUES(?, ?, ?, ?)', id, binding, key,
    JSON.stringify({ httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {}, storageClass: options.storageClass }));
  return id;
}
async function uploadPart(db, binding, key, id, part, body) {
  id = upload(db, 'uploadPart', binding, key, id).id;
  const written = await writeBody(db, 'uploadPart', body);
  // An abort while the body streamed in leaves nothing behind.
  const saved = db.transaction(() => {
    if (!db.rows('SELECT 1 FROM rer_r2_uploads WHERE id = ?', id).length) return null;
    const previous = db.rows('SELECT version FROM rer_r2_parts WHERE upload = ? AND part = ?', id, part)[0];
    if (previous) db.drop(previous.version);
    db.sql.exec('INSERT OR REPLACE INTO rer_r2_parts(upload, part, version, size, etag) VALUES(?, ?, ?, ?, ?)', id, part, written.version, written.size, written.sums.md5);
    return { partNumber: part, etag: written.sums.md5 };
  });
  if (!saved) { db.drop(written.version); upload(db, 'uploadPart', binding, key, id); }
  return saved;
}
function complete(db, binding, key, id, selected) {
  return db.transaction(() => {
    const options = JSON.parse(upload(db, 'complete', binding, key, id).options);
    const uploaded = new Map(db.rows('SELECT * FROM rer_r2_parts WHERE upload = ?', id).map(row => [row.part, row]));
    const numbers = selected.map(item => item.partNumber);
    if (new Set(numbers).size !== numbers.length) throw failure('complete', 'We encountered an internal error. Please try again.', 10001);
    const parts = selected.map(item => {
      const row = uploaded.get(item.partNumber);
      if (row?.etag !== item.etag) throw failure('complete', 'One or more of the specified parts could not be found.', 10025);
      return row;
    }).sort((a, b) => a.part - b.part);
    const version = randomId();
    let seq = 0, start = 0;
    for (const part of parts) {
      const count = db.rows('SELECT count(*) AS n FROM rer_r2_chunks WHERE version = ?', part.version)[0].n;
      db.sql.exec('UPDATE rer_r2_chunks SET version = ?, seq = seq + ?, start = start + ? WHERE version = ?', version, seq, start, part.version);
      seq += count; start += part.size;
    }
    for (const row of uploaded.values()) if (!parts.includes(row)) db.drop(row.version);
    db.sql.exec('DELETE FROM rer_r2_parts WHERE upload = ?', id);
    db.sql.exec('DELETE FROM rer_r2_uploads WHERE id = ?', id);
    const etag = createHash('md5').update(Buffer.concat(parts.map(part => Buffer.from(part.etag, 'hex')))).digest('hex') + `-${parts.length}`;
    return save(db, binding, key, { version, size: start }, { ...options, etag, checksums: {} });
  });
}
function abort(db, binding, key, id) {
  db.transaction(() => {
    for (const row of db.rows('SELECT version FROM rer_r2_parts WHERE upload = ?', String(id))) db.drop(row.version);
    db.sql.exec('DELETE FROM rer_r2_parts WHERE upload = ?', String(id));
    db.sql.exec('DELETE FROM rer_r2_uploads WHERE id = ? AND binding = ? AND key = ?', String(id), binding, key);
  });
}

const methods = { put, get, head: (db, binding, key) => { const row = db.object(binding, key); return row && metadata(row); },
  delete: remove, list, createMultipartUpload, uploadPart, complete, abort };
export function r2Call(db, binding, method, args) {
  if (!Object.hasOwn(methods, method)) throw new Error(`Unsupported R2 method: ${method}`);
  const [key, ...rest] = args;
  return methods[method](db, binding, method === 'list' ? key : method === 'delete' ? key : String(key), ...rest);
}
