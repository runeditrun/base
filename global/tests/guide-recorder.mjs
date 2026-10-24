// A stand-in for the platform's run-guide events route that writes down every
// request it gets, byte for byte. `mode` is how it answers: 'ok' stores the
// event (201), 'hang' accepts the connection and never answers, '404' is a
// platform where the route is not live yet.
import { createServer } from 'node:http';

export async function recorder(mode = 'ok') {
 const requests = [], sockets = new Set();
 const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
   requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
   if (mode === 'hang') return;
   response.writeHead(mode === 'ok' ? 201 : 404, { 'content-type': 'application/json' });
   response.end(mode === 'ok' ? '{"stored":true}' : '{"error":"not found"}');
  });
 });
 server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
 await new Promise(done => server.listen(0, '127.0.0.1', done));
 return {
  origin: `http://127.0.0.1:${server.address().port}`,
  requests,
  close: () => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(done); }),
 };
}
