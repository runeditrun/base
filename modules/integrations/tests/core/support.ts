import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { SqliteDatabase } from '../../core/sqlite.ts';
import { IntegrationsRepository } from '../../core/repository.ts';
import type { TrustedTransport, WireRequest, WireResponse } from '../../core/types.ts';
export async function database() {
  const dir = await mkdtemp(join(tmpdir(), 'integrations-'));
  const path = join(dir, 'store.sqlite');
  let db = new SqliteDatabase(path);
  db.migrate(await readFile(new URL('../../core/schema.sql', import.meta.url), 'utf8'));
  return { path, dir, get db() { return db; }, repo: (namespace = 'tenant') => new IntegrationsRepository(db, namespace),
    restart() { db.close(); db = new SqliteDatabase(path); }, async close() { db.close(); await rm(dir, { recursive: true, force: true }); } };
}
/** The only HTTP mapping lives in tests: approved synthetic HTTPS -> a real listening receiver. */
export async function receiver(handler: (body: string, headers: Record<string, string>, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) {
  const server = createServer(async (req, res) => {
    try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      await handler(body, headers, req, res);
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const transport: TrustedTransport = { send(wire: WireRequest): Promise<WireResponse> {
    if (new URL(wire.url).hostname !== 'receiver.example.com') throw new Error('Test host not approved');
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: new URL(wire.url).pathname, method: 'POST', headers: wire.headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
          resolve({ status: res.statusCode!, headers, body: Buffer.concat(chunks).toString('utf8') }); }); res.on('error', reject);
      }); req.on('error', reject); req.end(wire.body);
    });
  } };
  return { transport, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}
