import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SqliteDatabase } from '../../core/sqlite.ts';
import { IntegrationsRepository } from '../../core/index.ts';
import type { TrustedTransport, WireRequest, WireResponse } from '../../core/index.ts';

export const webhookUrl = 'https://hooks.slack.com/services/TLOCAL/BLOCAL/localFixtureOnly';
export const botToken = ['xoxb', 'fixture', 'local', 'only'].join('-');
export const channel = 'CLOCAL123';
export const successBot = JSON.stringify({ ok: true, channel, ts: '1700000000.000001', message: { text: 'Local fixture' } });
export interface Received { url: string; body: string; headers: IncomingMessage['headers']; method?: string }
export type Reply = { status: number; body: string; headers?: Record<string, string> } | 'disconnect';

/** Test-only transport: exact provider origins with synthetic credentials map to loopback.
 * Production code has no test flag, fetch override, or arbitrary URL/port escape. */
export async function wireFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-wire-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-subj', '/CN=slack.com', '-addext', 'subjectAltName=DNS:slack.com,DNS:hooks.slack.com'], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'));
  const received: Received[] = [], replies: Reply[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url!, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers, method: req.method });
    const reply = replies.shift();
    if (!reply || reply === 'disconnect') { req.socket.destroy(); return; }
    res.writeHead(reply.status, reply.headers); res.end(reply.body);
  };
  const http = createHttpServer(handle), tls = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, handle);
  for (const server of [http, tls]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  }
  const transport: TrustedTransport = {
    async send(wire: WireRequest): Promise<WireResponse> {
      const url = new URL(wire.url);
      if (wire.url !== webhookUrl && wire.url !== 'https://slack.com/api/chat.postMessage') throw new Error('Test fixture destination refused');
      const secure = url.hostname === 'slack.com';
      const server = secure ? tls : http;
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture closed');
      return new Promise((resolve, reject) => {
        const send = secure ? httpsRequest : httpRequest;
        const req = send({ hostname: '127.0.0.1', port: address.port, path: url.pathname, method: 'POST',
          headers: { ...wire.headers, host: url.hostname }, agent: false,
          ...(secure ? { ca: cert, servername: url.hostname, rejectUnauthorized: true } : {}),
        }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('aborted', () => reject(new Error('Local response aborted')));
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
            resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers });
          });
        });
        req.setTimeout(2000, () => req.destroy(new Error('Local fixture timeout')));
        req.on('error', reject); req.end(wire.body);
      });
    },
  };
  return { transport, received, replies };
}
export function durableFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 't060-slack-db-'));
  const path = join(dir, 'deliveries.sqlite');
  let db = new SqliteDatabase(path);
  db.migrate(readFileSync(new URL('../../core/schema.sql', import.meta.url), 'utf8'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    repository: () => new IntegrationsRepository(db, 'installation'),
    restart() { db.close(); db = new SqliteDatabase(path); },
    bytes() { return Buffer.concat(['', '-wal'].map(suffix => { try { return readFileSync(path + suffix); } catch { return Buffer.alloc(0); } })).toString('utf8'); },
    execute(sql: string) { db.migrate(sql); },
  };
}
