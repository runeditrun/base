import { ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { outgoing } from './ingress.mjs';

// Keep the Worker response's cookies and selected protocol. ws owns the wire
// handshake (including key validation) and never negotiates compression here.
const handshakeHeaders = new Set(['connection', 'upgrade', 'sec-websocket-accept', 'sec-websocket-extensions', 'content-length', 'transfer-encoding']);
export function attachWebSockets(server, { engine, incoming, activity }) {
 const responses = new WeakMap(), sockets = new Set();
 const bridge = new WebSocketServer({ noServer:true, handleProtocols:() => false });
 bridge.on('headers', (headers, req) => {
  const response = responses.get(req); responses.delete(req);
  for (const [name, value] of response.headers) if (!handshakeHeaders.has(name) && name !== 'set-cookie') headers.push(`${name}: ${value}`);
  for (const cookie of response.headers.getSetCookie()) headers.push(`set-cookie: ${cookie}`);
 });
 const refuse = (req, socket, response) => {
  const res = new ServerResponse(req); res.assignSocket(socket);
  res.shouldKeepAlive = false;
  const headers = new Headers(response.headers); headers.set('connection', 'close');
  outgoing(new Response(response.body, { status:response.status, headers }), res);
 };
 server.on('upgrade', async (req, socket, head) => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  // A peer may disappear while ingress or the Worker is still dispatching.
  socket.on('error', () => socket.destroy());
  let pair, coupled = false;
  const abandon = () => { if (pair && !coupled) { try { pair.accept(); pair.close(1001, 'Client disconnected'); } catch {} } };
  socket.once('close', abandon);
  try {
   activity();
   if (req.headers.upgrade?.toLowerCase() !== 'websocket') return refuse(req, socket, new Response('Unsupported upgrade', { status:400 }));
   const request = await incoming(req); request.headers.set('upgrade', 'websocket');
   const response = await engine.fetch(request);
   pair = response.webSocket;
   if (socket.destroyed) { abandon(); return; }
   if (response.status !== 101) return refuse(req, socket, response);
   if (!pair || !engine.coupleWebSocket) return refuse(req, socket, new Response('Invalid WebSocket response', { status:502 }));
   responses.set(req, response);
   bridge.handleUpgrade(req, socket, head, ws => {
    coupled = true;
    ws.on('message', activity); ws.on('ping', activity); ws.on('pong', activity);
    pair.addEventListener('message', activity);
    // Miniflare's coupling preserves text/binary messages, queued app sends,
    // close codes and abrupt disconnects on its returned WebSocketPair.
    engine.coupleWebSocket(ws, pair).catch(() => { ws.terminate(); try { pair.close(1011, 'Bridge failed'); } catch {} });
   });
  } catch (cause) {
   abandon();
   if (!socket.destroyed) refuse(req, socket, new Response('Container upgrade failed', { status:cause.status ?? 500 }));
   console.error('Container upgrade failed:', cause.name);
  }
 });
 return () => { for (const socket of sockets) socket.destroy(); bridge.close(); };
}
