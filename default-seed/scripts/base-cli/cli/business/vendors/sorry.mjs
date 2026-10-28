import { object, list, assertCount, shape, fail } from './common.mjs';

// Sorry's public status page API, read anonymously from the page's own HTTPS
// address, as Lamp's Move in reads it (statuspage-import/sorry/fetch.ts,
// fetchSorryPublicResponses): /api/v1/status, the components and notices lists
// (25 a page, `meta.next_page`), then every notice's detail with its components
// and full update history. No key is sent or accepted.

const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;
/** The page's public HTTPS origin from its host name alone: no scheme, port,
 * path, credentials, IP address or local name can come from the inputs. */
export function originOf(inputs) {
  const page = object(inputs.page);
  if (Object.keys(page).some(key => key !== 'host')) fail('INVALID_INPUT');
  const host = page.host;
  if (typeof host !== 'string' || host.length > 253) fail('INVALID_INPUT');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(part => label.test(part)) || /^[0-9]+$/u.test(labels.at(-1))
    || ['localhost', 'local', 'internal', 'invalid', 'test'].includes(labels.at(-1))) fail('INVALID_INPUT');
  return `https://${host}`;
}
export const route = url => /^\/api\/v1\/(?:status|components|notices(?:\/(?:0|[1-9][0-9]{0,127}))?)$/u.test(url.pathname)
  && [...url.searchParams.keys()].every(key => key === 'page');

const resources = ['components', 'notices'];
/** The documented next page of one public list: the same collection, page n+1, or null. */
function nextPage(value, path, current) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 2048) fail('INVALID_PAGINATION');
  let next;
  try { next = new URL(value, 'https://sorry.invalid'); } catch { fail('INVALID_PAGINATION'); }
  const params = [...next.searchParams];
  if (next.username || next.password || next.hash || ![path, path.replace('/api/v1/', '/v1/')].includes(next.pathname)
    || params.length !== 1 || params[0][0] !== 'page' || params[0][1] !== String(current + 1)) fail('INVALID_PAGINATION');
  return `${path}?page=${current + 1}`;
}
/** Notice ids exactly as Sorry wrote them (large integers never pass through Number). */
function noticeIds(text) {
  const ids = [];
  JSON.parse(text, function (key, value, context) {
    // A notice is the object with a subject; its components and updates have none.
    if (key === 'id' && this && !Array.isArray(this) && Object.hasOwn(this, 'subject')) {
      const lexeme = typeof value === 'string' ? value : context?.source;
      if (typeof lexeme !== 'string' || !/^(?:0|[1-9][0-9]{0,127})$/u.test(lexeme)) fail('INVALID_RESPONSE');
      ids.push(lexeme);
    }
    return value;
  });
  return ids;
}

/** The bundle Lamp's import door reads for its `sorry` source (door-plan.ts
 * `doorExport`): the public page address, the saved responses under the file
 * names Lamp's Sorry reader requires, each with its original text, and the
 * acknowledgement that they are public. Every response here came from the
 * page's own unauthenticated API, so it is public by construction; Lamp still
 * refuses any private, unpublished or audience-scoped record, and the owner
 * reviews the plan before anything is imported. */
export async function* run(ctx) {
  const origin = originOf(ctx.inputs);
  const s = ctx.state ?? { phase: 0, page: 1, total: null, rows: 0, notices: [], index: 0 };
  shape(s, ['phase', 'page', 'total', 'rows', 'notices', 'index']);
  assertCount(s.phase, 4); assertCount(s.page, 50); assertCount(s.rows, 5000); assertCount(s.index, 5000);
  if (s.total !== null) assertCount(s.total, 5000);
  if (!Array.isArray(s.notices) || s.notices.length > 1250 || s.notices.some(id => typeof id !== 'string' || !/^(?:0|[1-9][0-9]{0,127})$/u.test(id))) fail('INVALID_CHECKPOINT');
  const file = (name, text, first = false) => (first ? '' : ',') + JSON.stringify({ name, text });
  while (s.phase < 4) {
    let bytes;
    if (s.phase === 0) {
      const { body, text } = await ctx.get('/api/v1/status');
      const page = object(object(body).page);
      if (typeof page.name !== 'string' || typeof page.url !== 'string') fail();
      ctx.records(1);
      s.phase = 1;
      bytes = JSON.stringify({ source: 'sorry', publicUrl: origin, publicAccessAcknowledged: true }).slice(0, -1) + ',"files":[' + file('sorry-status.json', text, true);
    } else if (s.phase <= 2) {
      const resource = resources[s.phase - 1], path = `/api/v1/${resource}`;
      const { body, text } = await ctx.get(s.page === 1 ? path : `${path}?page=${s.page}`);
      object(body); const rows = list(body[resource], 25), meta = object(body.meta);
      if (meta.count !== rows.length || !Number.isSafeInteger(meta.total_count) || s.total !== null && meta.total_count !== s.total) fail('INVALID_PAGINATION');
      ctx.records(rows.length);
      if (resource === 'notices') {
        const ids = noticeIds(text);
        if (ids.length !== rows.length || ids.some(id => s.notices.includes(id))) fail('DUPLICATE_ID');
        s.notices.push(...ids);
      }
      s.rows += rows.length; s.total = meta.total_count;
      const next = nextPage(meta.next_page, path, s.page);
      if (s.rows > s.total || Boolean(next) !== s.rows < s.total || next && !rows.length) fail('INVALID_PAGINATION');
      bytes = file(`sorry-${resource}${s.page === 1 ? '' : `-${s.page}`}.json`, text);
      if (next) { if (++s.page > 50) fail('PAGE_LIMIT'); }
      else { s.phase++; s.page = 1; s.total = null; s.rows = 0; }
    } else {
      if (s.index === s.notices.length) { s.phase = 4; yield ctx.item(']}\n', s); break; }
      const id = s.notices[s.index];
      const { body, text } = await ctx.get(`/api/v1/notices/${id}`);
      const notice = object(object(body).notice);
      const ids = noticeIds(text);
      if (ids.length !== 1 || ids[0] !== id || !Array.isArray(notice.components) || !Array.isArray(notice.updates)) fail('INVALID_RESPONSE');
      ctx.records(1 + notice.updates.length);
      bytes = file(`sorry-notice-${id}.json`, text);
      s.index++;
    }
    yield ctx.item(bytes, s);
  }
}
