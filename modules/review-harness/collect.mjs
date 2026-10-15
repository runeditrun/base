import { redact, safeUrl } from './privacy.mjs';

const states = new WeakMap();
export function pageState(page) {
  const state = states.get(page);
  if (!state) throw new Error('Capture needs a page from journey() or installCollection() before navigation');
  return state;
}

export async function installCollection(context, { origin, secrets = [], captureFiles = new Set() }) {
  // WebSocketRoute has no owning-page accessor. Collect sockets across the
  // context, including seed-created pages, into the next capture.
  const socketRequests = [];
  function observe(page) {
    if (states.has(page)) return;
    const state = { origin, secrets, captureFiles, socketRequests, documentStatus: null, errors: { page: [], console: [], settle: [] }, failedResponses: [], externalRequests: [] };
    states.set(page, state);
    page.on('pageerror', error => state.errors.page.push(redact(error.message, secrets)));
    page.on('console', message => {
      if (message.type() === 'error' || /hydration|did not match/i.test(message.text())) {
        state.errors.console.push({ text: redact(message.text(), secrets), url: safeUrl(message.location().url, secrets), resource: /^Failed to load resource:/i.test(message.text()) });
      }
    });
    page.on('response', response => {
      const request = response.request();
      const mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (mainDocument) state.documentStatus = response.status();
      if (new URL(response.url()).origin === origin && response.status() >= 400) {
        state.failedResponses.push({ url: safeUrl(response.url(), secrets), status: response.status(), mainDocument });
      }
    });
  }
  context.on('page', observe);
  for (const page of context.pages()) observe(page);
  await context.routeWebSocket('**/*', async socket => {
    const url = new URL(socket.url());
    const httpUrl = new URL(url);
    httpUrl.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
    if (httpUrl.origin === origin) { socket.connectToServer(); return; }
    socketRequests.push(safeUrl(url.href, secrets));
    await socket.close({ code: 1008, reason: 'External origin blocked' });
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin) return route.continue();
    let page;
    try { page = request.frame().page(); } catch { /* Service workers are disabled by journey. */ }
    if (page) { observe(page); states.get(page).externalRequests.push(safeUrl(url.href, secrets)); }
    await route.abort('blockedbyclient');
  });
}

export function snapshotCollection(state) {
  const result = { errors: structuredClone(state.errors), failedResponses: [...state.failedResponses], externalRequests: [...state.externalRequests, ...state.socketRequests.splice(0)] };
  state.errors = { page: [], console: [], settle: [] };
  state.failedResponses = []; state.externalRequests = [];
  return result;
}
