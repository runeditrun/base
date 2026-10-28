import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export async function demoEdge(t, account, plan) {
 const edge = createServer(async (request, response) => {
  try {
   const chunks = []; for await (const chunk of request) chunks.push(chunk);
   const bytes = Buffer.concat(chunks), headers = { ...request.headers, Authorization: request.headers.authorization };
   const body = headers['content-type']?.startsWith('multipart/form-data') ? await new Response(bytes, { headers }).formData() : bytes.toString();
   const result = await account.fetch(`https://api.cloudflare.com${request.url}`, { method: request.method, headers,
    ...(!['GET', 'HEAD'].includes(request.method) ? { body } : {}) });
   response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
 });
 await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
 t.after(async () => { edge.closeAllConnections(); await new Promise(resolve => edge.close(resolve)); });
 process.env.CLOUDFLARE_API_BASE_URL = `http://127.0.0.1:${edge.address().port}/client/v4`;
 t.mock.method(globalThis, 'fetch', async (input, init) => {
  const url = new URL(input);
  if (url.origin === 'https://cloudflare-dns.com') {
   if (!plan.hostnames.includes(url.searchParams.get('name'))) throw Error('unexpected DNS request');
   return Response.json({ Answer: [{ type: 1, data: '192.0.2.1' }] });
  }
  return account.fetch(input, init);
 });
 // Certificate transport only; keep the real awaitCertificates decision path.
 t.mock.method(tls, 'connect', options => {
  if (!plan.hostnames.includes(options.servername) || options.host !== '192.0.2.1' || options.rejectUnauthorized !== true) throw Error('unexpected TLS request');
  const socket = Object.assign(new EventEmitter(), { authorized: true, destroy() {},
   getPeerCertificate: () => ({ valid_to: 'test certificate expiry' }), getProtocol: () => 'TLSv1.3' });
  queueMicrotask(() => socket.emit('secureConnect'));
  return socket;
 });
 syncBuiltinESMExports();
 t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
