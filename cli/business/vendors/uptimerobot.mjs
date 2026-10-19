import { object, list, reference, shape, fail, withoutCredentials } from './common.mjs';

export const origin = 'https://api.uptimerobot.com';
const pagination = ['limit','offset','cursor','page','page_token'];
export const route = url => url.pathname === '/v3/monitors' && [...url.searchParams.keys()].every(x => pagination.includes(x));
export async function* run(ctx) {
  const state = ctx.state ?? { next: '/v3/monitors?limit=200', seen: [] };
  shape(state, ['next','seen']);
  if (!Array.isArray(state.seen) || state.seen.length > 600) fail('INVALID_CHECKPOINT');
  state.seen.forEach(value => reference(value, origin, /^\/v3\/monitors$/u, pagination));
  while (state.next !== null) {
    const url = reference(state.next, origin, /^\/v3\/monitors$/u, pagination);
    if (state.seen.includes(url.href)) fail('PAGINATION_CYCLE');
    const { body } = await ctx.get(url.href);
    object(body); ctx.records(list(body.data).length);
    if (!Object.hasOwn(body, 'nextLink')) fail();
    state.seen.push(url.href);
    state.next = body.nextLink == null ? null : reference(body.nextLink, origin, /^\/v3\/monitors$/u, pagination).href;
    yield ctx.item(JSON.stringify(withoutCredentials(body, pagination)) + '\n', state);
  }
}
