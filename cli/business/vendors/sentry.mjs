import { object, list, id, windowInputs, cursor, assertCount, shape, fail, withoutCredentials } from './common.mjs';

export const origins = Object.freeze({ us: 'https://us.sentry.io', de: 'https://de.sentry.io' });
const queries = ['per_page','limit','cursor','query','project','start','end','sort'];
export const route = url => /^\/api\/0\/(?:organizations\/[a-zA-Z0-9_-]+\/(?:projects|releases|issues)|projects\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/events\/[a-fA-F0-9]{32})\/$/u.test(url.pathname) && [...url.searchParams.keys()].every(x => queries.includes(x));
function nextCursor(headers) {
  const link = headers.get('link');
  if (!link) return null;
  const next = link.split(',').find(part => /\brel="next"/u.test(part));
  if (!next || /\bresults="false"/u.test(next)) return null;
  if (!/\bresults="true"/u.test(next)) fail('INVALID_PAGINATION');
  const value = next.match(/\bcursor="([^"]+)"/u)?.[1];
  if (!value) fail('INVALID_PAGINATION');
  return cursor(value);
}
export async function* run(ctx) {
  const organization = object(ctx.inputs.organization);
  id(organization.id); id(organization.slug);
  if (!Object.hasOwn(origins, organization.region)) fail('INVALID_INPUT');
  const window = windowInputs(ctx.inputs);
  const selected = ctx.inputs.events ?? [];
  list(selected, 100);
  for (const event of selected) {
    id(event.project);
    if (!/^[a-fA-F0-9]{32}$/u.test(event.eventId)) fail('INVALID_INPUT');
  }
  const s = ctx.state ?? { phase: 0, projects: [], index: 0, event: 0, cursor: null, seen: [], collections: 0, page: 0 };
  shape(s, ['phase','projects','index','event','cursor','seen','collections','page']);
  assertCount(s.phase, 5); assertCount(s.index, 100); assertCount(s.event, 100); assertCount(s.collections, 100); assertCount(s.page, 100);
  if (!Array.isArray(s.projects) || s.projects.length > 49 || !Array.isArray(s.seen) || s.seen.length > 100) fail('INVALID_CHECKPOINT');
  s.projects.forEach(id); cursor(s.cursor); s.seen.forEach(cursor);
  if (s.phase === 0) {
    s.phase = 1;
    yield ctx.item(JSON.stringify({ format: 'spool-sentry-org-export', version: 1, organization: { id: organization.id, slug: organization.slug, region: organization.region }, window }).slice(0,-1) + ',"collections":[', s);
  }
  while (s.phase < 5) {
    if (s.phase === 3 && s.index >= s.projects.length) { s.phase = 4; s.index = 0; }
    if (s.phase === 4 && s.index >= s.projects.length) {
      if (selected.some(event => !s.projects.includes(event.project))) fail('EVENT_PROJECT_NOT_EXPORTED');
      s.phase = 5;
      yield ctx.item('],"omissions":' + JSON.stringify([
        'Only explicitly selected event IDs are exported; all other historical events, retention gaps and inaccessible records are outside this bundle.',
        'Issues include all statuses in the requested time window. Projects and releases are not time-filtered.',
        'Attachments, source maps, sessions, tracing, replays, profiles, feedback, check-ins, logs and metrics are not exported.',
      ]) + '}\n', s);
      break;
    }
    const kind = [null,'projects','releases','issues','events'][s.phase];
    const project = s.phase >= 3 ? id(s.projects[s.index]) : null;
    const events = selected.filter(event => event.project === project);
    let response, next = null;
    if (s.phase === 4) {
      if (s.event >= events.length && events.length) fail('INVALID_CHECKPOINT');
      if (events.length) {
        const result = await ctx.get(`/api/0/projects/${organization.slug}/${project}/events/${events[s.event].eventId}/`);
        object(result.body);
        response = [result.body]; ctx.records(1);
        const at = Date.parse(result.body.dateCreated ?? result.body.dateReceived);
        if (!Number.isFinite(at) || at < Date.parse(window.start) || at > Date.parse(window.end)) fail('EVENT_OUTSIDE_WINDOW');
        next = s.event + 1 < events.length ? `selected-${s.event + 1}` : null;
      } else response = [];
    } else {
      const query = new URLSearchParams(s.phase === 3 ? { limit: '100', project, query: '', start: window.start, end: window.end, sort: 'date' } : { per_page: '100' });
      if (s.cursor !== null) query.set('cursor', s.cursor);
      const { body, headers } = await ctx.get(`/api/0/organizations/${organization.slug}/${kind}/?${query}`);
      response = list(body, 100); ctx.records(response.length); next = nextCursor(headers);
      if (s.phase === 1) for (const row of response) {
        const slug = id(row.slug);
        if (s.projects.includes(slug)) fail('DUPLICATE_ID');
        s.projects.push(slug);
        if (s.projects.length > 49) fail('COLLECTION_LIMIT');
      }
    }
    if (next !== null && (next === s.cursor || s.seen.includes(next))) fail('PAGINATION_CYCLE');
    if (++s.page > 100) fail('PAGE_LIMIT');
    let bytes = s.cursor === null ? (s.collections ? ',' : '') + JSON.stringify({kind,project}).slice(0,-1) + ',"pages":[' : ',';
    bytes += JSON.stringify({ cursor: s.cursor, nextCursor: next, response: withoutCredentials(response, queries) });
    s.cursor = next;
    if (next === null) {
      bytes += ']}'; s.collections++; s.seen = []; s.page = 0; s.event = 0;
      if (s.phase < 3) s.phase++; else s.index++;
    } else { s.seen.push(next); if (s.phase === 4) s.event++; }
    yield ctx.item(bytes, s);
  }
}
