import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { d1Database } from '../index.ts';
import { createReferenceSalesJobs } from '../../../default-seed/src/core/features/durable-jobs/runtime.server.ts';
import { createSalesRepository } from '../../../default-seed/src/core/features/durable-jobs/repository.server.ts';
import { createSalesKind } from '../../../default-seed/src/core/features/durable-jobs/sales.server.ts';
import { referenceSalesAuthority } from '../../../default-seed/src/core/features/durable-jobs/authority.server.ts';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(await realpath(join(root, 'default-seed/node_modules/wrangler/package.json')));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const { unstable_splitSqlQuery: splitSql } = require('wrangler');
const output = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'] });
export const installationId = 'us-sales-installation';
export const input = (operationKey: string) => ({ kind: 'reference.sales.refresh', operationKey, requestedRevision: { sourceRevision: 'october-close' }, inputRef: { sourceId: 'us-retail' } });
export const sales = Array.from({ length: 2000 }, (_, index) => ({ ordinal: index + 1,
  saleId: `US-${['CA','NY','TX','FL','WA'][index % 5]}-202610${String(1 + index % 24).padStart(2,'0')}-${String(index + 1).padStart(6,'0')}`,
  amountMinor: 500 + ((index + 1) * 7919) % 250000, currency: 'USD' as const }));
export const expectedKeys = sales.map(row => row.saleId).sort();
export const expectedCents = sales.reduce((sum, row) => sum + row.amountMinor, 0);

export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'base-durable-door-'));
  let mf: InstanceType<typeof Miniflare>;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await mf.dispatchFetch('http://localhost/test-dispatch', { method: 'POST', body: JSON.stringify({url:origin+req.url, method:req.method, headers:{...req.headers,'CF-Connecting-IP':'127.0.0.1'}, ...(chunks.length ? {body:Buffer.concat(chunks).toString('utf8')} : {})}), redirect: 'manual' });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const bindings = { AUTH_ORIGIN: origin, AUTH_LOCAL: 'true', OWNER_EMAIL: 'sales-owner@example.test',
    SESSION_SECRET: 'disposable-test-only-session-secret-00001', INSTALLATION_KEY: 'd'.repeat(64),
    SETUP_TOKEN: 'disposable-test-only-setup-token-000001', DURABLE_JOBS_REFERENCE: 'true', RER_INSTALLATION_ID: installationId };
  const options = convertV4MiniflareOptions({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'sales' }, bindings });
  const start = () => new Miniflare({ ...options, resourcePersistencePath: join(directory, 'state') });
  mf = start();
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  await mf.ready;
  let db = await mf.getD1Database('DB');
  for (const file of (await readdir(join(root, 'default-seed/migrations/core'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(splitSql(await readFile(join(root, 'default-seed/migrations/core', file), 'utf8')).map((statement: string) => db.prepare(statement)));
  }
  const bootstrap = await fetch(origin + '/auth/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: bindings.SETUP_TOKEN, displayName: 'US Sales Owner' }), redirect: 'manual' });
  if (bootstrap.status !== 303) throw new Error(`Native bootstrap refused: ${bootstrap.status} ${JSON.stringify(await bootstrap.json())}`);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const ownerId = (await db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first()).id;
  const database = () => d1Database(db);
  const repository = () => createSalesRepository(database(), installationId);
  await repository().createTenant(null, ownerId); await repository().setMembership(null, ownerId, true);
  const authority = (tenantId: string | null = null, principalId = ownerId) => referenceSalesAuthority(database(), installationId, principalId, tenantId).then(value => { if (!value) throw new Error('fixture_authority_refused'); return value; });
  const jobs = (limits = {}, now?: () => number) => createReferenceSalesJobs({ database: database(), installationId, scheduler: 'native', limits, now });
  const populate = async (tenantId: string | null = null, rows = sales, revision = 'october-close') => {
    const repo = repository(); await repo.beginRevision(tenantId, 'us-retail', revision);
    for (let i = 0; i < rows.length; i += 100) await repo.appendRows(tenantId, 'us-retail', revision, rows.slice(i, i + 100));
    await repo.publishRevision(tenantId, 'us-retail', revision);
  };
  const call = async (path = '', body?: unknown, headers = {}) => {
    const response = await fetch(origin + '/api/rer/jobs' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
    return { status: response.status, body: await response.json() };
  };
  const sessionFile = join(directory, 'session'); await writeFile(sessionFile, cookie, { mode: 0o600 });
  const cli = async (args: string[]) => new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/rer.mjs', 'jobs', ...args, '--cwd', 'default-seed', '--origin', origin, '--session-file', sessionFile, '--json'], { cwd: root, stdio: ['ignore','pipe','pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(`CLI refused ${code}: ${stdout}`)); else resolve(JSON.parse(stdout)); });
  });
  return { origin, directory, ownerId, get db() { return db; }, database, repository, authority, jobs, populate, call, cli,
    async restart() { await mf.dispose(); mf = start(); await mf.ready; db = await mf.getD1Database('DB'); },
    kind: () => createSalesKind(database()),
  };
}
