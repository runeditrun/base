// Test-only HTTPS CONNECT gateway. Builders have only an internal Docker network;
// this gateway is their only route and accepts two public package registries.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
const allowed = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
const server = http.createServer((req, res) => { res.writeHead(403).end(); });
server.on('connect', async (req, client, head) => {
  const match = /^([a-z0-9.-]+):443$/.exec(req.url);
  if (!match || !allowed.has(match[1])) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  try {
    const { address } = await dns.lookup(match[1], { family: 4 });
    if (/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)) throw new Error('nonpublic-registry');
    const remote = net.connect(443, address, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); remote.write(head); remote.pipe(client); client.pipe(remote); });
    remote.setTimeout(120000, () => remote.destroy()); remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy());
    fs.appendFileSync('/tmp/registry-access.jsonl', JSON.stringify({ hostname: match[1], address, utc: new Date().toISOString() }) + '\n');
  } catch { client.destroy(); }
});
fs.writeFileSync('/tmp/registry-access.jsonl', '');
server.listen(8123, '0.0.0.0');
