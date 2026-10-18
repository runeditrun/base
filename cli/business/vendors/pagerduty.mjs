import { object, list, id, windowInputs, assertCount, shape, fail, withoutCredentials } from './common.mjs';

export const origin = 'https://api.pagerduty.com';
export const route = url => /^\/(?:users|escalation_policies|schedules(?:\/[a-zA-Z0-9_-]+(?:\/overrides)?)?)$/u.test(url.pathname) && [...url.searchParams.keys()].every(x => ['limit','offset','since','until','overflow'].includes(x));
function advance(body, state) {
  if (typeof body.more !== 'boolean') fail();
  if (body.more) {
    const limit = assertCount(body.limit, 100);
    if (!limit || body.offset !== state.offset) fail('INVALID_PAGINATION');
    state.offset += limit;
    assertCount(state.offset, 100000);
  } else state.offset = 0;
  return body.more;
}
export async function* run(ctx) {
  const { start, end } = windowInputs(ctx.inputs);
  const window = new URLSearchParams({ since: start, until: end });
  const s = ctx.state ?? { phase: 0, offset: 0, schedules: [], index: 0, first: true };
  shape(s, ['phase','offset','schedules','index','first']);
  if (typeof s.first !== 'boolean') fail('INVALID_CHECKPOINT');
  assertCount(s.phase, 5); assertCount(s.offset, 100000); assertCount(s.index, 500);
  if (!Array.isArray(s.schedules) || s.schedules.length > 500) fail('INVALID_CHECKPOINT');
  s.schedules.forEach(id);
  while (s.phase < 5) {
    let bytes;
    if (s.phase === 0 || s.phase === 1 || s.phase === 4) {
      const kind = ['users','schedules',null,null,'escalation_policies'][s.phase];
      const { body } = await ctx.get(`/${kind}?limit=100&offset=${s.offset}`);
      object(body); const rows = list(body[kind], 100); ctx.records(s.phase === 1 ? 0 : rows.length);
      if (s.phase === 1) {
        for (const row of rows) { const value = id(row.id); if (s.schedules.includes(value)) fail('DUPLICATE_ID'); s.schedules.push(value); }
        if (s.schedules.length > 500) fail('RECORD_LIMIT');
        bytes = '';
      } else {
        bytes = (s.first ? (s.phase === 0 ? '{"users":[' : '],"escalation_policies":[') : ',') + JSON.stringify(withoutCredentials(body));
        s.first = false;
      }
      if (!advance(body, s)) { s.phase++; s.first = true; }
    } else if (s.phase === 2) {
      if (s.index === s.schedules.length) { s.phase = 3; s.index = 0; s.first = true; bytes = s.schedules.length ? '' : '],"schedules":['; }
      else {
        const { body } = await ctx.get(`/schedules/${id(s.schedules[s.index])}?${window}`);
        object(body); object(body.schedule); ctx.records(1);
        bytes = (s.first ? '],"schedules":[' : ',') + JSON.stringify(withoutCredentials(body));
        s.first = false; s.index++;
      }
    } else {
      if (s.index === s.schedules.length) { s.phase = 4; s.first = true; bytes = s.schedules.length ? '' : '],"overrides":['; }
      else {
        const schedule = id(s.schedules[s.index]);
        const { body } = await ctx.get(`/schedules/${schedule}/overrides?${window}&overflow=true`);
        object(body); ctx.records(list(body.overrides).length);
        bytes = (s.first ? '],"overrides":[' : ',') + JSON.stringify(withoutCredentials({ ...body, schedule_id: schedule }));
        s.first = false;
        s.index++;
      }
    }
    if (s.phase === 5) bytes += ']}\n';
    yield ctx.item(bytes, s);
  }
}
