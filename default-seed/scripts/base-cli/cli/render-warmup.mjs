import { shared } from './shared.mjs';
import { RerError } from './errors.mjs';

// `rer dev` serves modules on demand: the app's first document render loads its
// whole server module graph (router, route tree, server functions) one round trip
// at a time, which takes seconds on an idle computer and minutes on a busy one.
// The owner-entry check lands on first-run setup, a Worker response that renders
// no route, so on a fresh install that cost fell on the first signed-in page after
// the owner's first form post, and every signed-in request waited behind it until a
// restart (whose entry check lands on the signed-in app) had loaded the graph.
// Render one document through the app's own router here, before the server is
// announced ready. Any path no route claims reaches the router's not-found page.
export const WARMUP_PATH = '/rer-warmup';
const BUDGET_MS = 300000;

// Resolves once the app has answered the document, whatever its status: the page
// being rendered is the point, not the page. A request that never answers, or a
// server that dies meanwhile, refuses the launch instead of announcing a ready
// server whose pages hang.
export async function warmDocumentRender(url, probe, signal, store, budgetMs = BUDGET_MS) {
 const { appFetch } = await shared('app-fetch.mjs');
 store.report?.('Preparing the first page render; a first launch can take a few minutes on a busy computer.');
 const timeout = AbortSignal.timeout(budgetMs);
 try {
  const response = await appFetch(new URL(WARMUP_PATH, url), { headers: { 'x-rer-probe': probe, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.any([signal, timeout].filter(Boolean)) });
  await response.arrayBuffer();
 } catch (error) {
  signal?.throwIfAborted();
  const log = store.logPath ? ` Check the startup log at ${store.redact(store.logPath)}.` : '';
  throw new RerError('first_render_failed', `The application did not render its first page ${timeout.aborted ? `within ${Math.round(budgetMs / 1000)} s` : 'before the server was announced ready'}.${log} Run ~/.local/bin/rer dev again.`, 1, { cause: error });
 }
}
