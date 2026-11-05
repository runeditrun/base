import { materialize, ordered } from './zendesk-store.mjs';
import { fetchPage } from './zendesk-pages.mjs';

export async function tickets(ctx) {
 const { store, inputs } = ctx;
 let state = store.state;
 const path = state.path ?? `/api/v2/incremental/tickets/cursor?start_time=${inputs.mode === 'sweep' ? inputs.highWater : 0}&per_page=1000`;
 state = await fetchPage({ ...ctx, state, kind: 'tickets', path, incremental: true,
  onDone: state => ({ ...state, phase: inputs.mode === 'census' ? 'done' : 'B', index: 0 }) });
 return state;
}
export async function comments(ctx) {
 const { store, inputs } = ctx, state = store.state, data = await materialize(store);
 // A sweep refetches complete comments only for changed tickets; the retained
 // store still supplies every older ticket to the eventual complete snapshot.
 const ids = ordered([...data.tickets].filter(([, { row }]) => row.status !== 'deleted' && !row.deleted && (inputs.mode !== 'sweep' || row.generated_timestamp > inputs.highWater)).map(([id]) => id));
 const ticket = ids[state.index];
 if (ticket === undefined) { await store.commit({ ...state, phase: inputs.mode === 'sweep' ? 'done' : 'C', path: null, index: 0 }); return; }
 await fetchPage({ ...ctx, state, kind: 'comments', path: state.path ?? `/api/v2/tickets/${ticket}/comments?page[size]=100&include_inline_images=true`, extra: { ticket, reset: state.path === null },
  onDone: state => ({ ...state, phase: 'attachments', index: state.index, attachmentIndex: 0 }) });
}
