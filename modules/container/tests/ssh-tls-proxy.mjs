// Test-only TCP/SNI routing edge. Certificates and HTTP remain end-to-end
// between the ordinary client and each stock Caddy deployment.
import { createServer, connect } from 'node:net';
function serverName(record) {
 let at = 5 + 4 + 2 + 32;
 at += 1 + record[at];
 at += 2 + record.readUInt16BE(at);
 at += 1 + record[at];
 const end = at + 2 + record.readUInt16BE(at); at += 2;
 while (at + 4 <= end) {
  const kind = record.readUInt16BE(at), size = record.readUInt16BE(at + 2); at += 4;
  if (kind === 0 && record[at + 2] === 0) return record.subarray(at + 5, at + 5 + record.readUInt16BE(at + 3)).toString();
  at += size;
 }
 throw Error('ClientHello has no server name');
}
export async function sniProxy(routes, port) {
 const sockets = new Set(), routed = new Set();
 const server = createServer(client => {
  sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => client.destroy());
  let buffered = Buffer.alloc(0);
  const hello = bytes => {
   buffered = Buffer.concat([buffered, bytes]);
   if (buffered.length < 5 || buffered.length < 5 + buffered.readUInt16BE(3)) return;
   client.off('data', hello); client.pause();
   try {
    const hostname = serverName(buffered), target = routes[hostname];
    if (!target) throw Error('Unknown SNI route');
    const upstream = connect(target, '127.0.0.1', () => { routed.add(hostname); upstream.write(buffered); client.pipe(upstream).pipe(client); client.resume(); });
    sockets.add(upstream); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); }); upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
   } catch { client.destroy(); }
  };
  client.on('data', hello);
 });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
 return { routed, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
