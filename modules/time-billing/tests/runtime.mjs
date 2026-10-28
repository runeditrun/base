import { installD1Preflight } from '../../container/adapters/d1-workerd-setup.mjs';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedNative, state } from './setup.mjs';
import { populateLegacy } from './legacy.mjs';
import { policies } from './profiles.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packages = await readdir(join(root, 'node_modules/.pnpm'));
const wrangler = packages.find(name => name.startsWith('wrangler@4.129.1_'));
if (!wrangler) throw new Error('Install the frozen workspace dependencies before running time-billing workerd tests.');
const require = createRequire(join(root, 'node_modules/.pnpm', wrangler, 'node_modules/wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, D1_PLUGIN } = require('miniflare');
const { unstable_splitSqlQuery: splitSqlQuery } = require('wrangler');
installD1Preflight(D1_PLUGIN);
const { build } = require('esbuild');
const output = await build({ entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
function encode(_key, value) { return value instanceof Uint8Array ? { $bytes: [...value] } : value; }
function decode(_key, value) { return value && typeof value === 'object' && '$bytes' in value ? new Uint8Array(value.$bytes) : value; }

/** Disposable real Worker/D1 with the consumer's numbered migration history. */
export async function openTimeBillingRuntime({ profile, populatedUpgrade = false }) {
  const directory = await mkdtemp(join(tmpdir(), 'time-billing-'));
  const migrationDirectory = join(directory, 'migrations');
  await mkdir(migrationDirectory);
  await Promise.all([
    copyFile(new URL('./migrations/0001-native.sql', import.meta.url), join(migrationDirectory, '0001-native.sql')),
    copyFile(new URL('../schema/time-billing.sql', import.meta.url), join(migrationDirectory, '0002-time-billing.sql')),
    copyFile(new URL('./migrations/0003-legacy-time.sql', import.meta.url), join(migrationDirectory, '0003-legacy-time.sql')),
    writeFile(join(directory, 'wrangler.json'), JSON.stringify({ name: 'time-billing-consumer', compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'time-billing-consumer', database_id: 'time-billing-consumer', migrations_dir: './migrations' }] })),
  ]);
  const init = () => new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-09-01', d1Databases: { DB: 'time-billing-consumer' } }), resourcePersistencePath: resolve(directory, 'state') });
  let mf = init();
  const database = () => mf.getD1Database('DB');
  async function migrate(names) {
    const db = await database();
    for (const name of names) {
      const sql = await readFile(join(migrationDirectory, name), 'utf8');
      const statements = splitSqlQuery(sql);
      if (!statements.length) throw new Error(`Empty numbered migration ${name}`);
      await db.batch([...statements.map(statement => db.prepare(statement)), db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
    }
  }
  async function call(path, { actor = 'preparer', installation = 'source', input } = {}) {
    const response = await mf.dispatchFetch(`https://time.test${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer test-${actor}`, 'X-Installation': installation, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input, encode) }) });
    const result = JSON.parse(await response.text(), decode);
    if (!response.ok) { const error = new Error(`${response.status}: ${result.message ?? result.code}`); error.code = result.code; throw error; }
    return result;
  }
  try {
    const db = await database();
    await db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);');
    await migrate(['0001-native.sql']);
    await seedNative(db, 'source', policies);
    if (populatedUpgrade) await populateLegacy(db, policies.find(policy => policy.id === profile.policyId));
    else await migrate(['0002-time-billing.sql', '0003-legacy-time.sql']);
    return {
      command: (action, input, actor, installation) => call(`/api/time/commands/${action}`, { input, actor, installation }),
      readEntry: (id, actor, installation) => call(`/api/time/entries/${encodeURIComponent(id)}`, { actor, installation }),
      readPacket: (id, actor, installation) => call(`/api/time/packets/${encodeURIComponent(id)}`, { actor, installation }),
      exportRecords: (work, actor, installation) => call(`/api/time/export?kind=${encodeURIComponent(work.kind)}&id=${encodeURIComponent(work.id)}`, { actor, installation }),
      async source(source, work) { const db = await database(); await db.prepare('INSERT INTO native_sources(installation,kind,id,revision,work_id) VALUES(?,?,?,?,?) ON CONFLICT(installation,kind,id) DO UPDATE SET revision=excluded.revision').bind('source', source.kind, source.id, source.revision, work.id).run(); },
      async membership(actor, { active }) { const db = await database(); await db.prepare('UPDATE native_memberships SET active=? WHERE installation=? AND person_id=?').bind(Number(active), 'source', actor === 'agent' ? 'preparer' : actor).run(); },
      async reviewPolicy({ enabled, revision }) { const db = await database(); await db.prepare('UPDATE native_review_policy SET enabled=?,revision=? WHERE installation=? AND work_id=?').bind(Number(enabled), revision, 'source', 'project-1').run(); },
      async rate({ minorNumerator, durationMsDenominator, revision }) { const db = await database(); await db.prepare('UPDATE native_rates SET minor_numerator=?,duration_denominator=?,revision=? WHERE installation=? AND work_id=?').bind(minorNumerator, durationMsDenominator, revision, 'source', 'project-1').run(); },
      async clock(iso) { const db = await database(); await db.prepare('UPDATE native_control SET current_time=? WHERE installation=?').bind(iso, 'source').run(); },
      async outcomeFailure(enabled) { const db = await database(); await db.prepare('UPDATE native_control SET fail_outcome=? WHERE installation=?').bind(Number(enabled), 'source').run(); },
      nativeState: async (installation = 'source') => state(await database(), installation),
      async nativeAdjustment() { const db = await database(); const row = await db.prepare('SELECT * FROM native_adjustments WHERE installation=? AND id=?').bind('source', 'adjustment-1').first(); return { kind: 'native', source: { kind: 'native-adjustment', id: row.id, revision: row.revision }, amountMinor: row.amount_minor, currency: row.currency, calculation: { engine: row.engine, revision: row.calculation_revision, basis: { ledger: 'cost-ledger-4', reason: 'signed native cost correction' } } }; },
      legacyRead: () => call('/api/legacy/time', { actor: 'finance' }),
      legacyWrite: () => call('/api/legacy/time', { actor: 'finance', input: { id: 'legacy-entry', note: 'Last native note before maintenance cutover.' } }),
      upgrade: () => migrate(['0002-time-billing.sql', '0003-legacy-time.sql']),
      target: async installation => seedNative(await database(), installation, policies),
      async restart() { await mf.dispose(); mf = init(); await mf.ready; },
      async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { await mf.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
}
