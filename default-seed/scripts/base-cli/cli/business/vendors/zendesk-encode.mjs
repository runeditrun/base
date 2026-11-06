import { credentialShaped } from '../detector.mjs';
import { assertChunk } from '../outbound.mjs';
import { fail, hash } from './common.mjs';
import { materialize, encode, ordered } from './zendesk-store.mjs';
import { attachmentReferences } from './zendesk-attachments.mjs';
import { attachmentPath } from './zendesk-transport.mjs';

export const FORMAT = 'happytohelp-zendesk-offline-v1';
const omissions = ['audits','metrics','satisfaction','side conversations','groups','brands','forms','macros','triggers','views','automations','photos','thumbnails','archived articles','community'];
const escapePointer = value => value.replace(/~/gu, '~0').replace(/\//gu, '~1');
/** Redact only the delivered copy. Raw responses remain private evidence in
 * the store. Expand prefix detector hits to their whole token and PEM hits to
 * their whole block; assertChunk remains the final authority on every line. */
function cleaned(value, kind, id, report, pointer = '') {
 const removed = () => report.removals.push({ kind, id, pointer: pointer || '/' });
 if (Array.isArray(value)) return value.map((child,index) => cleaned(child, kind, id, report, `${pointer}/${index}`));
 if (value && typeof value === 'object') {
  const result = Object.create(null);
  for (const [key,child] of Object.entries(value)) {
   if (['content_url','download_url','original_url'].includes(key)) { report.redactedUrls++; continue; }
   if (credentialShaped(key)) fail('CREDENTIAL_SHAPE_UNREMOVABLE');
   result[key] = cleaned(child, kind, id, report, `${pointer}/${escapePointer(key)}`);
  }
  return result;
 }
 if (typeof value !== 'string') return value;
 let text = value.replace(/https?:\/\/[^\s<>"']+/giu, match => {
  let url; try { url = new URL(match); } catch { return match; }
  if (attachmentPath(url.pathname)) { report.redactedUrls++; return '[removed]'; }
  if (!url.username && !url.password && !url.search && !url.hash) return match;
  url.username = ''; url.password = ''; url.search = ''; url.hash = ''; report.redactedUrls++; return url.href;
 });
 text = text.replace(/(?:\/\/[^\s<>"'/]+)?\/(?:api\/v2\/)?attachments\/[^\s<>"']*/giu, () => { report.redactedUrls++; return '[removed]'; });
 text = text.replace(/-----\s*BEGIN\s+([A-Z0-9 ]+)-----[\s\S]*?-----\s*END\s+\1-----/giu, () => { removed(); return '[removed]'; });
 // SSH material includes a scheme and key separated by whitespace.
 text = text.replace(/\b(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-[\w-]+)\s+[A-Za-z0-9+/=]+/gu, () => { removed(); return '[removed]'; });
 text = text.replace(/[^\s<>"'`,;(){}\[\]]+/gu, token => {
  if (!credentialShaped(token)) return token;
  removed(); return '[removed]';
 });
 text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, () => { removed(); return '[removed]'; });
 text = text.replace(/https?:\/\/[^\s<>"']+/giu, match => {
  let url;
  try { url = new URL(match); } catch { return match; }
  if (!url.username && !url.password && !url.search && !url.hash) return match;
  url.username = ''; url.password = ''; url.search = ''; url.hash = ''; report.redactedUrls++; return url.href;
 });
 if (credentialShaped(text.replace(/[\r\n\t]/gu, ' '))) fail('CREDENTIAL_SHAPE_UNREMOVABLE');
 return text;
}
const deleted = row => row.status === 'deleted' || row.deleted === true;
const sortedRows = map => ordered(map.keys()).map(id => [id, map.get(id)]);
function attachmentCensus(references, data, { article = false } = {}) {
 const blobs = new Map(), undelivered = {};
 let fetched = 0, bytes = 0;
 for (const ref of references) {
  const item = data.attachments.get(ref.key);
  if (item?.blob) { fetched++; bytes += item.blob.bytes; blobs.set(item.blob.sha256, item.blob.bytes); }
  const reason = item?.reason ?? (!item ? 'not_fetched' : article ? 'pending_guide' : null);
  if (reason) undelivered[reason] = (undelivered[reason] ?? 0) + 1;
 }
 return { referenced: references.length, fetched, bytes, uniqueBlobs: blobs.size, undelivered };
}
export async function encodeSnapshot(store, { origin, packageBindings = false } = {}) {
 const data = await materialize(store), report = { removals: [], redactedUrls: 0 }, lines = [], byKind = {}, blobs = new Map();
 const add = (kind, id, value) => {
  // Bindings are integrity-checked original bytes, never redaction input.
  const clean = kind === 'ticket' ? { ...cleaned({ ...value, _offline: undefined }, kind, id, report), _offline: value._offline } : cleaned(value, kind, id, report);
  const line = encode({ [kind]: clean });
  if (line.length > 64 * 1024 * 1024) fail('RECORD_LIMIT');
  try { assertChunk(line, []); } catch { fail('CREDENTIAL_SHAPE_UNREMOVABLE'); }
  lines.push(line); byKind[kind] = (byKind[kind] ?? 0) + 1;
 };
 let needsPackage = packageBindings, commentTotal = 0, publicComments = 0;
 const tombstones = [], byStatus = {}, refs = attachmentReferences(data);
 for (const [id,{ row, provenance }] of sortedRows(data.tickets)) {
  byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  if (deleted(row)) { tombstones.push({ id: row.id, generated_timestamp: row.generated_timestamp }); continue; }
  const comments = sortedRows(data.comments.get(id) ?? new Map()).map(([,item]) => item.row), bindings = [];
  for (const comment of comments) {
   commentTotal++; if (comment.public === true) publicComments++;
   for (const attachment of comment.attachments ?? []) {
    const stored = data.attachments.get(`ticket:${id}:${comment.id}:${attachment.id}`);
    if (!stored?.blob) continue;
    const blob = stored.blob;
    if (blob.bytes > 48 * 1024) needsPackage = true;
    blobs.set(`blobs/${blob.sha256}`, blob);
    bindings.push({ attachment_id: attachment.id, comment_id: comment.id, path: `blobs/${blob.sha256}`, sha256: blob.sha256,
     ...(!packageBindings ? { base64: (await store.get(blob)).toString('base64') } : {}) });
   }
  }
  if (bindings.length > 20) needsPackage = true;
  const value = { ...row, comments, _offline: { format: FORMAT, comments_complete: true, attachments: bindings,
   history: { metrics: 'missing', audits: 'missing' }, metric_events: [], audits: [], provenance: [provenance, ...[...(data.comments.get(id)?.values() ?? [])].map(item => item.provenance)] } };
  if (encode(value).length > 128 * 1024) needsPackage = true;
  add('ticket', id, value);
 }
 for (const [kind, map] of [['user', data.users], ['organization', data.organizations], ['ticket_field', data.ticket_fields]]) {
  for (const [id,{ row, provenance }] of sortedRows(map)) add(kind, id, { ...row, _offline_provenance: [provenance] });
 }
 let restricted = 0, draft = 0;
 for (const [id,{ row, provenance }] of sortedRows(data.articles)) {
  if (row.user_segment_id != null || row.user_segment_ids?.length) restricted++;
  if (row.draft) draft++;
  add('article', id, { ...row, draft: row.draft === true, user_segment_id: row.user_segment_id ?? null, user_segment_ids: row.user_segment_ids ?? [], _offline_provenance: [provenance] });
 }
 const records = Buffer.concat(lines);
 if (records.length > 2 * 1024 * 1024 || lines.length > 5000) needsPackage = true;
 const census = { format: 'rer-zendesk-census/1', tickets: { unique: data.tickets.size, deleted: tombstones.length,
  deletedIdsSha256: hash(tombstones.map(row => `${row.id}\n`).join('')), byStatus, maxId: ordered(data.tickets.keys()).at(-1) ?? null },
  comments: { total: commentTotal, public: publicComments, private: commentTotal - publicComments },
  attachments: attachmentCensus(refs.filter(ref => ref.ticket), data), articleAttachments: attachmentCensus(refs.filter(ref => ref.article), data, { article: true }),
  users: { unique: data.users.size, inactive: [...data.users.values()].filter(item => item.row.active === false).length, withoutEmail: [...data.users.values()].filter(item => !item.row.email).length },
  organizations: data.organizations.size, fields: data.ticket_fields.size,
  guide: { available: data.available, articles: data.articles.size, restricted, draft, translations: data.translations.size, sections: data.sections.size, categories: data.categories.size, segments: data.user_segments.size },
  records: byKind, undelivered: { tombstones: tombstones.length, translations: data.translations.size, sections: data.sections.size, categories: data.categories.size, segments: data.user_segments.size, articleAttachments: data.article_attachments.size }, credentialShapesRemoved: report.removals.length, credentialRemovals: report.removals, redactedUrls: report.redactedUrls, highWater: data.highWater, omissions };
 const files = new Map([['records-000001.ndjson', records], ['tombstones.ndjson', Buffer.concat(tombstones.map(row => encode(row)))]]);
 for (const kind of ['translations','sections','categories','user_segments','article_attachments']) {
  const bytes = Buffer.concat([...data[kind]].sort(([a],[b]) => a.localeCompare(b)).map(([id,{ row }]) => encode(cleaned(row, kind, id, report))));
  try { assertChunk(bytes, []); } catch { fail('CREDENTIAL_SHAPE_UNREMOVABLE'); }
  files.set(`guide/${kind}.ndjson`, bytes);
 }
 // Article media remains in the package/store even before HH can import it.
 for (const ref of refs.filter(ref => ref.article)) {
  const blob = data.attachments.get(ref.key)?.blob;
  if (blob) blobs.set(`blobs/${blob.sha256}`, blob);
 }
 census.credentialShapesRemoved = report.removals.length; census.redactedUrls = report.redactedUrls;
 files.set('census.json', encode(census));
 if (needsPackage && !packageBindings) return encodeSnapshot(store, { origin, packageBindings: true });
 return { kind: needsPackage ? 'package' : 'bundle', bytes: records, files, blobs, census,
  source: { format: FORMAT, version: 1, origin, exportedAt: store.state.exportedAt, synthetic: false, adapter: 'rer:zendesk' } };
}
