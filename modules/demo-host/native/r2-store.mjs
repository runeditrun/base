import { createHash } from 'node:crypto';

// Demo R2 objects live in the visitor's own SQLite storage, beside the app,
// so every call is local to wherever the visitor's Durable Object runs.
// Bodies are split into chunks well under the 2 MB per-value limit.
export const CHUNK = 1 << 20;
// Seeded data is kilobytes and seed upload limits are at most ~20 MB per file.
// 256 MiB leaves room for real demo uploads while bounding one hour's storage.
export const VISITOR_LIMIT = 256 * CHUNK;
const SCHEMA = `CREATE TABLE IF NOT EXISTS rer_r2_objects(binding TEXT NOT NULL, key TEXT NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, uploaded INTEGER NOT NULL, http TEXT NOT NULL, custom TEXT NOT NULL, checksums TEXT NOT NULL, class TEXT NOT NULL, PRIMARY KEY(binding, key));
CREATE TABLE IF NOT EXISTS rer_r2_chunks(version TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(version, seq));
CREATE TABLE IF NOT EXISTS rer_r2_uploads(id TEXT PRIMARY KEY, binding TEXT NOT NULL, key TEXT NOT NULL, options TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rer_r2_parts(upload TEXT NOT NULL, part INTEGER NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY(upload, part));`;
const HASHES = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

export const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export function store(storage) {
  const sql = storage.sql;
  sql.exec(SCHEMA);
  const rows = (query, ...args) => sql.exec(query, ...args).toArray();
  return { sql, rows, transaction: run => storage.transactionSync(run),
    object: (binding, key) => rows('SELECT * FROM rer_r2_objects WHERE binding = ? AND key = ?', binding, key)[0] ?? null,
    used: () => rows('SELECT COALESCE(SUM(size), 0) AS n FROM rer_r2_chunks')[0].n,
    drop(version) { sql.exec('DELETE FROM rer_r2_chunks WHERE version = ?', version); },
  };
}

const bytesOf = body => {
  if (body === null || body === undefined) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return null;
};
async function* pieces(body) {
  const whole = bytesOf(body);
  if (whole) { yield whole; return; }
  if (!(body instanceof ReadableStream)) throw new TypeError('put: The body must be a string, ArrayBuffer, ArrayBufferView, Blob or ReadableStream.');
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield bytesOf(value) ?? (() => { throw new TypeError('put: The body stream must contain bytes.'); })();
    }
  } finally { reader.releaseLock(); }
}

// Writes a body under a fresh version. The object row is swapped separately,
// so a failed or oversized write leaves the previous object untouched.
export async function writeBody(db, method, body, { hashes = [], replaces = 0 } = {}) {
  const version = randomId(), digests = Object.fromEntries(['md5', ...hashes].map(name => [name, createHash(name)]));
  let size = 0, seq = 0, pending = [], pendingSize = 0;
  const flush = () => {
    if (!pendingSize) return;
    if (db.used() - replaces + pendingSize > VISITOR_LIMIT) {
      const error = new Error(`${method}: Your proposed upload exceeds this demo's storage limit of ${VISITOR_LIMIT / CHUNK} MiB per visitor. (100100)`);
      error.code = 100100;
      throw error;
    }
    const data = new Uint8Array(pendingSize);
    let at = 0;
    for (const piece of pending) { data.set(piece, at); at += piece.length; }
    db.sql.exec('INSERT INTO rer_r2_chunks(version, seq, start, size, data) VALUES(?, ?, ?, ?, ?)', version, seq++, size - pendingSize, pendingSize, data.buffer);
    pending = []; pendingSize = 0;
  };
  try {
    for await (const piece of pieces(body)) {
      for (let at = 0; at < piece.length;) {
        const take = Math.min(CHUNK - pendingSize, piece.length - at), part = piece.subarray(at, at + take);
        for (const digest of Object.values(digests)) digest.update(part);
        pending.push(part); pendingSize += take; size += take; at += take;
        if (pendingSize === CHUNK) flush();
      }
    }
    flush();
  } catch (error) { db.drop(version); throw error; }
  const sums = Object.fromEntries(Object.entries(digests).map(([name, digest]) => [name, digest.digest('hex')]));
  return { version, size, sums };
}
export const checksumNames = options => Object.keys(HASHES).filter(name => name !== 'md5' && options?.[name] !== undefined);
export function verifyChecksums(method, options, sums) {
  for (const name of Object.keys(HASHES)) {
    const expected = options?.[name];
    if (expected === undefined) continue;
    const hex = typeof expected === 'string' ? expected.toLowerCase() : Buffer.from(bytesOf(expected)).toString('hex');
    if (hex !== sums[name]) throw new Error(`${method}: The ${HASHES[name]} checksum you specified did not match what we received. (10037)`);
  }
}

// A range read of one version; small reads are returned whole, larger ones
// stream chunk by chunk so a visitor's big object never sits in memory.
export function readBody(db, version, offset, length) {
  const end = offset + length, query = (from, limit) => db.rows('SELECT seq, start, data FROM rer_r2_chunks WHERE version = ? AND seq >= ? AND start < ? AND start + size > ? ORDER BY seq LIMIT ?', version, from, end, offset, limit);
  const slice = row => { const data = new Uint8Array(row.data); return data.subarray(Math.max(0, offset - row.start), Math.min(data.length, end - row.start)); };
  if (length <= 4 * CHUNK) {
    const result = new Uint8Array(length);
    let at = 0;
    for (const row of query(0, 1e9)) { const part = slice(row); result.set(part, at); at += part.length; }
    if (at !== length) throw new Error('get: The object changed while it was read.');
    return result;
  }
  let next = 0, sent = 0;
  return new ReadableStream({ type: 'bytes', pull(controller) {
    const [row] = query(next, 1);
    if (!row) { if (sent === length) controller.close(); else controller.error(new Error('get: The object changed while it was read.')); return; }
    next = row.seq + 1;
    const part = slice(row); sent += part.length;
    controller.enqueue(part.slice());
    if (sent === length) controller.close();
  } });
}
