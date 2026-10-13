import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Test-only network redirection. The production transport still processes real TLS
 * response events, enforces its limits, and requires certificate verification.
 * Its validated public address is checked before this fixture routes to loopback. */
export async function tlsReceiver(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'integrations-tls-'));
  const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
  const host = 'tls-receiver.example.com';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { stdio: 'ignore' });
  const cert = await readFile(certPath), key = await readFile(keyPath);
  const server = https.createServer({ key, cert }, handler), sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const nativeRequest = https.request, nativeLookup = dns.lookup;
  dns.lookup = (async (hostname: string) => {
    assert.equal(hostname, host);
    return [{ address: '93.184.216.34', family: 4 }];
  }) as unknown as typeof dns.lookup;
  https.request = ((url: URL, options: https.RequestOptions, listener: (res: IncomingMessage) => void) => {
    assert.equal(url.hostname, host); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    let checked = false;
    options.lookup!(host, { family: 0, hints: 0, all: false }, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); checked = true;
    });
    assert.equal(checked, true);
    return nativeRequest({ ...options, hostname: '127.0.0.1', port, path: url.pathname, servername: host, ca: cert }, listener);
  }) as typeof https.request;
  syncBuiltinESMExports();
  return {
    url: `https://${host}`, sockets,
    async close() {
      https.request = nativeRequest; dns.lookup = nativeLookup; syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
