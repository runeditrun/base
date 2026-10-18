import { object, list, id, timestamp, reference, cursor, assertCount, hash, shape, fail, withoutCredentials } from './common.mjs';

export const origin = 'https://api.calendly.com';
const queries = ['user','count','event_type','min_start_time','page_token'];
export const route = url => /^\/(?:users\/me|event_types|user_availability_schedules|event_type_availability_schedules|scheduled_events(?:\/[a-zA-Z0-9_-]+\/invitees)?)$/u.test(url.pathname) && [...url.searchParams.keys()].every(x => queries.includes(x));
function identity(uri, kind) {
  const url = reference(uri, origin, new RegExp(`^/${kind}/[a-zA-Z0-9_-]+$`, 'u'));
  return id(url.pathname.split('/').at(-1));
}
function nextToken(body, path, previous) {
  object(body.pagination);
  const next = body.pagination.next_page;
  if (next == null) {
    if (body.pagination.next_page_token != null) return cursor(body.pagination.next_page_token);
    return null;
  }
  const url = reference(next, origin, new RegExp(`^${path}$`, 'u'), queries);
  const token = cursor(url.searchParams.get('page_token'));
  if (!token || token === previous) fail('INVALID_PAGINATION');
  return token;
}
export async function* run(ctx) {
  const s = ctx.state ?? { phase: 0, user: null, types: [], events: [], index: 0, token: null, seen: [], files: [], asOf: timestamp(ctx.inputs.asOf ?? new Date().toISOString()) };
  shape(s, ['phase','user','types','events','index','token','seen','files','asOf']);
  assertCount(s.phase, 7); assertCount(s.index, 500); timestamp(s.asOf); cursor(s.token);
  if (!Array.isArray(s.types) || s.types.length > 100 || !Array.isArray(s.events) || s.events.length > 500 || !Array.isArray(s.files) || s.files.length > 600 || !Array.isArray(s.seen) || s.seen.length > 600) fail('INVALID_CHECKPOINT');
  s.types.forEach(id); s.events.forEach(id); if (s.user !== null) id(s.user);
  s.seen.forEach(cursor);
  for (const file of s.files) {
    shape(file, ['name','resource','page','size','sha256','capturedAt']);
    if (typeof file.name !== 'string' || !/^(?:user|event_types|schedules|event_availability|scheduled_events|invitees)-\d{6}\.json$/u.test(file.name) || !['user','event_types','schedules','event_availability','scheduled_events','invitees'].includes(file.resource) || !/^[a-f0-9]{64}$/u.test(file.sha256) || file.capturedAt !== s.asOf) fail('INVALID_CHECKPOINT');
    assertCount(file.page, 600); assertCount(file.size, 1024 * 1024);
  }
  while (s.phase < 7) {
    if (s.phase === 3 && s.index >= s.types.length) { s.phase = 4; s.index = 0; }
    if (s.phase === 5 && s.index >= s.events.length) s.phase = 6;
    if (s.phase === 6) {
      s.phase = 7;
      yield ctx.item(JSON.stringify({ version: 1, capturedAt: s.asOf, files: s.files }) + '\n', s, 'manifest.json');
      break;
    }
    const resource = ['user','event_types','schedules','event_availability','scheduled_events','invitees'][s.phase];
    const path = ['/users/me','/event_types','/user_availability_schedules','/event_type_availability_schedules','/scheduled_events',`/scheduled_events/${s.events[s.index]}/invitees`][s.phase];
    const query = new URLSearchParams();
    if (s.phase !== 0) query.set('count', '100');
    if ([1,2,4].includes(s.phase)) query.set('user', `${origin}/users/${id(s.user)}`);
    if (s.phase === 3) query.set('event_type', `${origin}/event_types/${id(s.types[s.index])}`);
    if (s.phase === 4) query.set('min_start_time', s.asOf);
    if (s.token !== null) query.set('page_token', s.token);
    const { body } = await ctx.get(path + (query.size ? `?${query}` : ''));
    object(body);
    const rows = s.phase === 0 ? [object(body.resource)] : list(body.collection);
    if (rows.some(row => Buffer.byteLength(JSON.stringify(row)) > 512 * 1024)) fail('RECORD_BYTE_LIMIT');
    ctx.records(rows.length);
    if (s.phase === 0) s.user = identity(rows[0].uri, 'users');
    if (s.phase === 1 || s.phase === 4) {
      const values = s.phase === 1 ? s.types : s.events;
      const kind = s.phase === 1 ? 'event_types' : 'scheduled_events';
      for (const row of rows) {
        const value = identity(row.uri, kind);
        if (values.includes(value)) fail('DUPLICATE_ID');
        values.push(value);
      }
      if (values.length > (s.phase === 1 ? 100 : 500)) fail('RECORD_LIMIT');
    }
    const next = s.phase === 0 ? null : nextToken(body, path, s.token);
    if (next !== null && (next === s.token || s.seen.includes(next))) fail('PAGINATION_CYCLE');
    const name = `${resource}-${String(s.files.length + 1).padStart(6,'0')}.json`;
    const bytes = Buffer.from(JSON.stringify(withoutCredentials(body, queries)) + '\n');
    if (s.files.length >= 600) fail('FILE_LIMIT');
    s.files.push({ name, resource, page: s.seen.length + 1, size: bytes.length, sha256: hash(bytes), capturedAt: s.asOf });
    s.token = next;
    if (next === null) {
      s.seen = [];
      if (s.phase === 3 || s.phase === 5) s.index++;
      else { s.phase++; s.index = 0; }
    } else s.seen.push(next);
    yield ctx.item(bytes, s, name);
  }
}
