import { VendorExportError, fail } from './common.mjs';
import { materialize, numericId, ordered } from './zendesk-store.mjs';
import { publicLocation, attachmentPath } from './zendesk-transport.mjs';

export function attachmentReferences(data) {
 const refs = [];
 for (const [ticket, comments] of data.comments) {
  if (data.tickets.get(ticket)?.row.status === 'deleted' || data.tickets.get(ticket)?.row.deleted) continue;
  for (const [comment, { row }] of comments) for (const attachment of row.attachments ?? []) refs.push({ key: `ticket:${ticket}:${comment}:${numericId(attachment.id)}`, ticket, comment, attachment });
 }
 for (const [id, { row }] of data.article_attachments) refs.push({ key: `article:${id}`, article: id.split(':')[1], attachment: row });
 return refs.sort((a,b) => a.key.localeCompare(b.key));
}
export async function download(request, origin, attachment) {
 if (attachment.deleted) return { reason: 'deleted' };
 if (attachment.malware_scan_result === 'malware_found' || attachment.malware_found) return { reason: 'malware_found' };
 const size = attachment.size;
 if (!Number.isSafeInteger(size) || size < 0) fail('INVALID_RESPONSE');
 if (size > 64 * 1024 * 1024) return { reason: 'too_large' };
 let url;
 try { url = new URL(attachment.content_url); } catch { return { reason: 'refused_location' }; }
 if (url.origin !== origin || !attachmentPath(url.pathname) || !await publicLocation(attachment.content_url, origin)) return { reason: 'refused_location' };
 let response;
 try {
  response = await request(url.href, { attachment: true, binary: true, maxBytes: 64 * 1024 * 1024, redirect: 'manual', allow: [403,404,410] });
  if (response.location !== undefined) {
   const next = await publicLocation(response.location, origin);
   if (!next) return { reason: 'refused_location' };
   response = await request(next.href, { attachment: true, binary: true, authenticated: false, maxBytes: 64 * 1024 * 1024, redirect: 'error', allow: [403,404,410] });
  }
 } catch (error) {
  if (error instanceof VendorExportError && error.code === 'REFUSED_LOCATION') return { reason: 'refused_location' };
  throw error;
 }
 if ([403,404,410].includes(response.status)) return { reason: `http_${response.status}` };
 if (!response.bytes || response.bytes.length !== size) fail('ATTACHMENT_SIZE_MISMATCH');
 return { bytes: response.bytes };
}
export async function attachments(ctx) {
 const { store, request, origin, inputs } = ctx, state = store.state, data = await materialize(store);
 const ids = ordered([...data.tickets].filter(([, { row }]) => row.status !== 'deleted' && !row.deleted && (inputs.mode !== 'sweep' || row.generated_timestamp > inputs.highWater)).map(([id]) => id));
 const ticket = ids[state.index];
 const refs = attachmentReferences(data).filter(ref => state.phase === 'guide_attachments' ? ref.article : ref.ticket === ticket);
 const ref = refs[state.attachmentIndex];
 if (!ref) {
  await store.commit(state.phase === 'guide_attachments' ? { ...state, phase: 'done', attachmentIndex: 0 } : { ...state, phase: 'B', path: null, index: state.index + 1, attachmentIndex: 0 });
  return;
 }
 const previous = data.attachments.get(ref.key);
 if (previous && previous.sourceHash === JSON.stringify(ref.attachment)) {
  await store.commit({ ...state, attachmentIndex: state.attachmentIndex + 1 }); return;
 }
 const result = await download(request, origin, ref.attachment);
 const blob = result.bytes ? await store.put(result.bytes) : null;
 await store.commit({ ...state, attachmentIndex: state.attachmentIndex + 1, bytes: state.bytes + (blob?.bytes ?? 0) },
  { kind: 'attachment', key: ref.key, sourceHash: JSON.stringify(ref.attachment), ...(blob ? { blob } : { reason: result.reason }) }, blob ? [blob] : []);
}
