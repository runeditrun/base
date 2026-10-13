import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { IntegrationsRepository } from '../../index.ts';
import type { TrustedTransport, WireRequest, WireResponse } from '../../index.ts';
import { SqliteDatabase } from '../../core/sqlite.ts';

export async function store(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 't060-public-'));
  const path = join(directory, 'integrations.sqlite');
  let sql = new SqliteDatabase(path);
  sql.migrate(await readFile(new URL('../../core/schema.sql', import.meta.url), 'utf8'));
  t.after(async () => { sql.close(); await rm(directory, { recursive: true, force: true }); });
  return { get sql() { return sql; }, repo: (namespace = 'installation') => new IntegrationsRepository(sql, namespace),
    restart() { sql.close(); sql = new SqliteDatabase(path); },
    async contents() {
      const [tables] = await sql.batch([{ sql: "SELECT name FROM sqlite_master WHERE type='table'" }]);
      return JSON.stringify(await sql.batch(tables!.map(row => ({ sql: `SELECT * FROM "${String(row.name).replaceAll('"', '""')}"` }))));
    },
  };
}
export interface Received { url: string; body: string; rawBody: Uint8Array; headers: Record<string, string> }
/** Explicit test-only exact-URL mapping. Never exported as an application transport. */
export async function loopback(t: TestContext, urls: string[], handle: (wire: Received, req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const received: Received[] = [], failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[name] = value;
      const wire = { url: headers['x-fixture-url']!, body: Buffer.concat(chunks).toString('utf8'), rawBody: Buffer.concat(chunks), headers };
      received.push(wire); await handle(wire, req, res);
    } catch (error) { failures.push(error); res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback address');
  const transport: TrustedTransport = {
    async send(wire: WireRequest): Promise<WireResponse> {
      if (!urls.includes(wire.url) || new URL(wire.url).protocol !== 'https:') throw new Error('Unapproved fixture URL');
      return new Promise((resolve, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/',
          headers: { ...wire.headers, 'x-fixture-url': wire.url }, agent: false }, res => {
          const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
          res.on('error', reject); res.on('aborted', () => reject(new Error('Response aborted')));
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string') headers[key] = value;
            resolve({ status: res.statusCode!, headers, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        outgoing.setTimeout(2000, () => outgoing.destroy(new Error('Fixture timeout')));
        outgoing.on('error', reject); outgoing.end(wire.body);
      });
    },
  };
  return { transport, received, failures };
}
