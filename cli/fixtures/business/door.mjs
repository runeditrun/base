import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const CHUNK = 65_536;

/** A seed's import door at the network edge, after modules/import-kit/src/door
 * ("Grants", "Requests", "Archives", "Catch-up and recovery"): every request needs
 * its own unused grant for that action, chunks are 64 KiB except the last, plan is
 * a preview that writes nothing native, a namespace with an applied import
 * (`baselines`: its source ids) plans only catch-ups, a bounded catch-up grant
 * refuses a change of 5% or more, and archive and restore-check keep and parse an
 * exact copy with no native writes. `mint` stands in for the platform's ES256 signer. */
export async function door(t) {
 const state = { grants: new Map(), requests: [], uploads: new Map(), plans: [], archives: new Map(), baselines: new Map(), nativeWrites: 0, bundleModes: [], stateDir: null };
 function mint(action, namespace, { catchup } = {}) {
  const token = `${part({ alg: 'ES256', typ: 'rer-import-grant+jwt', kid: 'fixture' })}.${part({ action, namespace, jti: randomUUID(), ...(catchup ? { catchup } : {}) })}.${randomBytes(64).toString('base64url')}`;
  state.grants.set(token, { action, namespace, catchup, used: false });
  return token;
 }
 const refuse = (code, status = 400) => { throw Object.assign(Error(code), { code, status }); };
 async function uploads(body, namespace) {
  const keys = ['uploadId', 'name', 'bundleSha256', 'totalBytes', 'totalChunks', 'index', 'chunkSha256', 'base64'];
  if (Object.keys(body).some(key => !keys.includes(key))) refuse('invalid_upload_input');
  if (state.stateDir) for (const name of await readdir(state.stateDir)) if (/^export-[0-9a-f]{32}\.bundle$/.test(name)) state.bundleModes.push((await stat(join(state.stateDir, name))).mode & 0o777);
  if (!/^[a-f0-9]{64}$/.test(body.bundleSha256) || !/^[a-f0-9]{64}$/.test(body.chunkSha256)) refuse('invalid_sha256');
  if (!Number.isSafeInteger(body.totalBytes) || body.totalBytes < 1 || body.totalBytes > 2 * 1024 * 1024 || body.totalChunks !== Math.ceil(body.totalBytes / CHUNK)
   || !Number.isSafeInteger(body.index) || body.index < 0 || body.index >= body.totalChunks) refuse('quota_or_chunk_limit');
  const bytes = Buffer.from(body.base64, 'base64');
  if (bytes.length !== (body.index < body.totalChunks - 1 ? CHUNK : body.totalBytes - CHUNK * (body.totalChunks - 1))) refuse('invalid_chunk_size');
  if (sha256(bytes) !== body.chunkSha256) refuse('chunk_sha256_mismatch');
  let upload;
  if (body.uploadId === undefined) {
   if (body.index !== 0) refuse('upload_not_found', 404);
   upload = { id: randomUUID(), namespace, name: body.name, bundleSha256: body.bundleSha256, totalBytes: body.totalBytes, totalChunks: body.totalChunks, chunks: new Map() };
   state.uploads.set(upload.id, upload);
  } else {
   upload = state.uploads.get(body.uploadId);
   if (!upload || upload.namespace !== namespace) refuse('upload_not_found', 404);
   if (upload.name !== body.name || upload.bundleSha256 !== body.bundleSha256 || upload.totalBytes !== body.totalBytes || upload.totalChunks !== body.totalChunks) refuse('upload_metadata_mismatch', 409);
  }
  upload.chunks.set(body.index, bytes);
  const complete = upload.chunks.size === upload.totalChunks;
  if (complete) {
   upload.bytes = Buffer.concat([...upload.chunks.keys()].sort((a, b) => a - b).map(index => upload.chunks.get(index)));
   if (sha256(upload.bytes) !== upload.bundleSha256) refuse('bundle_sha256_mismatch');
  }
  return { uploadId: upload.id, bundleSha256: upload.bundleSha256, received: [...upload.chunks].map(([ordinal, chunk]) => ({ ordinal, sha256: sha256(chunk), size: chunk.length })), complete };
 }
 // Uptime's reader: one saved v3 monitors page per NDJSON line.
 const read = bytes => bytes.toString('utf8').trim().split('\n').flatMap(line => JSON.parse(line).data);
 const counts = monitors => ({ input: monitors.length, unique: monitors.length, duplicates: 0, mapped: monitors.length, unmapped: 0, rejected: 0, effects: monitors.length, byKind: { monitor: monitors.length } });
 function uploaded(id, namespace) {
  const upload = state.uploads.get(id);
  if (!upload || upload.namespace !== namespace) refuse('upload_not_found', 404);
  if (!upload.bytes) refuse('upload_incomplete', 409);
  return upload;
 }
 function plan(body, grant) {
  if (Object.keys(body).some(key => !['uploadId', 'catchup'].includes(key)) || body.catchup !== undefined && typeof body.catchup !== 'boolean') refuse('invalid_plan_input');
  const upload = uploaded(body.uploadId, grant.namespace), monitors = read(upload.bytes), baseline = state.baselines.get(grant.namespace);
  if (baseline && body.catchup !== true) refuse('catchup_required', 409);
  if (!baseline && (body.catchup === true || grant.catchup === 'bounded')) refuse('catchup_requires_baseline', 409);
  const ids = monitors.map(monitor => String(monitor.id)), additions = baseline ? ids.filter(id => !baseline.includes(id)) : ids;
  const unchanged = baseline ? ids.filter(id => baseline.includes(id)) : [], gone = baseline ? baseline.filter(id => !ids.includes(id)) : [];
  if (grant.catchup === 'bounded') {
   if (gone.length) refuse('catchup_requires_proposal:source_records_gone', 409);
   if (additions.length * 100 >= baseline.length * 5) refuse('catchup_requires_proposal:change_must_be_under_five_percent', 409);
  }
  const planId = randomUUID(), fingerprint = sha256(Buffer.concat([upload.bytes, Buffer.from(planId)]));
  state.plans.push({ planId, uploadId: upload.id, fingerprint, bundleSha256: upload.bundleSha256, namespace: grant.namespace, records: monitors.length, catchup: body.catchup === true, standing: grant.catchup === 'bounded' });
  return { planId, fingerprint, bundleSha256: upload.bundleSha256,
   summary: { sourceRecords: monitors.length, created: additions.length, updated: 0, unchanged: unchanged.length, gone: gone.length },
   counts: counts(monitors), rejected: [], diagnostics: [],
   differences: { additions: additions.map(id => ({ sourceId: id })), replacements: [], unchanged: unchanged.map(id => ({ sourceId: id })), gone: gone.map(id => ({ sourceId: id })) } };
 }
 const answer = archive => ({ archiveId: archive.id, key: `business-archive/${archive.tool}/${archive.takenAt}`, tool: archive.tool, takenAt: archive.takenAt,
  bundleSha256: sha256(archive.bytes), bytes: archive.bytes.length, counts: counts(read(archive.bytes)) });
 function archive(body, namespace) {
  if (Object.keys(body).some(key => !['uploadId', 'tool', 'takenAt'].includes(key))) refuse('invalid_archive_input');
  if (typeof body.tool !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.tool)) refuse('invalid_tool');
  if (typeof body.takenAt !== 'string' || !Number.isFinite(Date.parse(body.takenAt)) || new Date(body.takenAt).toISOString() !== body.takenAt) refuse('invalid_taken_at');
  const upload = uploaded(body.uploadId, namespace), existing = [...state.archives.values()].find(item => item.uploadId === upload.id);
  if (existing && (existing.tool !== body.tool || existing.takenAt !== body.takenAt)) refuse('archive_exists', 409);
  // The archive holds its own copy of the exact uploaded bytes; nothing native is written.
  const kept = existing ?? { id: randomUUID(), namespace, uploadId: upload.id, tool: body.tool, takenAt: body.takenAt, bytes: Buffer.from(upload.bytes) };
  state.archives.set(kept.id, kept);
  return answer(kept);
 }
 /** Reads an archive's bytes back and parses them, as a restore would, writing nothing native. */
 function restoreCheck(archiveId, namespace) {
  const kept = state.archives.get(archiveId);
  if (!kept || namespace !== undefined && kept.namespace !== namespace) refuse('archive_not_found', 404);
  state.restoreChecks = (state.restoreChecks ?? 0) + 1;
  return { ...answer(kept), rejected: [] };
 }
 const http = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const send = (value, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
  try {
   let raw = ''; for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 100_000) refuse('import_body_too_large', 413); }
   const action = /^\/api\/rer\/import\/(uploads|plan|archive|restore-check)$/.exec(request.url)?.[1];
   state.requests.push({ url: request.url, authorization: request.headers.authorization, body: raw });
   if (request.method !== 'POST' || !action) refuse('not_found', 404);
   const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
   const grant = state.grants.get(token);
   // Expired, replayed and wrong-action grants fail closed.
   if (!grant || grant.used || grant.action !== action) refuse('invalid_grant', 401);
   grant.used = true;
   let body; try { body = JSON.parse(raw); } catch { refuse('invalid_json'); }
   if (action === 'restore-check' && Object.keys(body).some(key => key !== 'archiveId')) refuse('invalid_restore_check_input');
   return send(action === 'uploads' ? await uploads(body, grant.namespace) : action === 'plan' ? plan(body, grant)
    : action === 'archive' ? archive(body, grant.namespace) : restoreCheck(body.archiveId, grant.namespace));
  } catch (error) { send({ error: error.code ?? 'import_door_conflict' }, error.status ?? 500); }
 });
 await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
 t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
 // Business's own restore-check of a reported archive (null when the door holds none).
 return { state, origin: `http://127.0.0.1:${http.address().port}`, mint, restoreCheck: archiveId => { try { return restoreCheck(archiveId); } catch { return null; } } };
}
