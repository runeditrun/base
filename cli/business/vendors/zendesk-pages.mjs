import { fail, object, list } from './common.mjs';
import { pagination } from './zendesk-transport.mjs';

/** Both documented comments envelopes, and Guide's offset envelopes, are
 * explicit: a missing end marker is an error rather than a short snapshot. */
export function nextPage(body, path, origin, { incremental = false, time = false } = {}) {
 object(body);
 const pathname = new URL(path, origin).pathname;
 if (incremental) {
  if (typeof body.end_of_stream !== 'boolean') fail('INVALID_PAGINATION');
  if (body.end_of_stream) return null;
  if (time) {
   if (!Number.isSafeInteger(body.end_time) || body.end_time < 1 || body.end_time <= Number(new URL(path, origin).searchParams.get('start_time') ?? 0)) fail('INVALID_PAGINATION');
   return `${pathname}?start_time=${body.end_time}&per_page=1000`;
  }
  if (typeof body.after_cursor !== 'string' || !body.after_cursor || body.after_cursor.length > 2048 || /[\u0000-\u0020\u007f]/u.test(body.after_cursor)) fail('INVALID_PAGINATION');
  const next = `${pathname}?cursor=${encodeURIComponent(body.after_cursor)}&per_page=1000`;
  if (new URL(path, origin).searchParams.get('cursor') === body.after_cursor) fail('INVALID_PAGINATION');
  if (body.after_url != null && pagination(body.after_url, origin, pathname, path) !== next) fail('INVALID_PAGINATION');
  return next;
 }
 if (body.meta && Object.hasOwn(body.meta, 'has_more')) {
  if (typeof body.meta.has_more !== 'boolean' || !body.links || !Object.hasOwn(body.links, 'next')) fail('INVALID_PAGINATION');
  if (!body.meta.has_more) { if (body.links.next !== null) fail('INVALID_PAGINATION'); return null; }
  return pagination(body.links.next, origin, pathname, path);
 }
 if (Object.hasOwn(body, 'next_page')) {
  const next = pagination(body.next_page, origin, pathname, path);
  if (next) {
   const current = new URL(path, origin), url = new URL(next, origin);
   if (url.searchParams.get('page') !== String(Number(current.searchParams.get('page') ?? 1) + 1)) fail('INVALID_PAGINATION');
  }
  return next;
 }
 fail('INVALID_PAGINATION');
}
export async function fetchPage({ store, request, origin, state, kind, path, extra = {}, incremental, time, allow404 = false, onDone }) {
 const response = await request(path, { allow: allow404 ? [404] : [] });
 if (response.status === 404) {
  const next = onDone({ ...state, path: null });
  await store.commit(next, { kind: 'guide_unavailable' });
  return next;
 }
 list(object(response.body)[kind], 1000);
 const next = nextPage(response.body, path, origin, { incremental, time });
 const nextState = next ? { ...state, path: next } : onDone({ ...state, path: null });
 nextState.requests = state.requests + 1;
 await store.page(kind, response, nextState, extra);
 return store.state;
}
