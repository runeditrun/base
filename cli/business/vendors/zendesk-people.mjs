import { fetchPage } from './zendesk-pages.mjs';
export async function people(ctx) {
 const state = ctx.store.state;
 const resources = { C: ['users', '/api/v2/incremental/users/cursor?start_time=0&per_page=1000', 'D'], D: ['organizations', '/api/v2/incremental/organizations?start_time=0&per_page=1000', 'E'], E: ['ticket_fields', '/api/v2/ticket_fields?page[size]=100', 'F'] };
 const [kind, path, next] = resources[state.phase];
 await fetchPage({ ...ctx, state, kind, path: state.path ?? path, incremental: state.phase !== 'E', time: state.phase === 'D', onDone: state => ({ ...state, phase: next, index: 0, stage: 0 }) });
}
