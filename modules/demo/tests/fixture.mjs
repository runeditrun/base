// A seed's Worker entry in miniature: the demo guard first, then routes that
// answer an HTML page under a strict CSP, JSON, and a page that sends out.
import { withDemo } from '../index.mjs';

const POLICY = "default-src 'none'; style-src 'self'";
const page = body => new Response(`<!doctype html><html><head><title>App</title></head><body class="app">${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY } });

export default withDemo({
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/json') return Response.json({ ok: true });
    if (pathname === '/send') return fetch('https://hooks.example.com/notify', { method: 'POST' }).then(() => page('sent'), () => page('refused'));
    return page('<header>App header</header>');
  },
}, { owner: async () => null });
