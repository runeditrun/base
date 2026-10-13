// Transport only: the public CLI still builds, packages, deploys and checks
// readiness through its real lifecycle and owner-account implementation.
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return original(request);
  if (!['https://api.cloudflare.com', `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`, 'https://idp.example.test', process.env.AUTH_TEST_DEPLOY_ORIGIN].includes(url.origin)) throw Error('Unexpected test network destination');
  const headers = new Headers(request.headers);
  for (const name of ['host', 'connection', 'transfer-encoding']) headers.delete(name);
  headers.set('x-test-destination', request.url);
  headers.set('x-test-redirect', request.redirect);
  const response = await original(process.env.AUTH_TEST_DEPLOY_EDGE, { method: request.method, headers,
    ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
    signal: request.signal, redirect: 'manual' });
  return new Response(response.body, { status: response.status, headers: response.headers });
};
