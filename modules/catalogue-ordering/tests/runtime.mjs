import { installD1Preflight } from '../../container/adapters/d1-workerd-setup.mjs';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, INSTALLATION, people, seedNative } from './seed.mjs';
export { supportedProfiles } from './seed.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// The same frozen Wrangler graph as operator-auth, including pnpm's physical layout.
const packages = await readdir(join(root, 'node_modules/.pnpm'));
const wrangler = packages.find(name => name.startsWith('wrangler@4.129.1_'));
if (!wrangler) throw new Error('Install the frozen workspace dependencies before running catalogue workerd tests.');
const require = createRequire(join(root, 'node_modules/.pnpm', wrangler, 'node_modules/wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, D1_PLUGIN } = require('miniflare');
const { unstable_splitSqlQuery: splitSqlQuery } = require('wrangler');
const { build } = require('esbuild');
installD1Preflight(D1_PLUGIN);
const bundles = new Map();
const originalModule = fileURLToPath(new URL('../', import.meta.url));
const originalAdapter = fileURLToPath(new URL('./native-adapters.mjs', import.meta.url));

function workerBundle(moduleRoot, nativeAdapter) {
  const cacheKey = `${moduleRoot}\0${nativeAdapter}`;
  if (!bundles.has(cacheKey)) bundles.set(cacheKey, build({
    entryPoints: [fileURLToPath(new URL('./worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    plugins: [{ name: 'real-copied-catalogue-module', setup(builder) {
      builder.onResolve({ filter: /^\.\/native-adapters\.mjs$/ }, args => {
        if (args.importer === fileURLToPath(new URL('./worker.mjs', import.meta.url))) return { path: nativeAdapter };
      });
      builder.onResolve({ filter: /^\.\.\/(index|arithmetic)\.ts$/ }, args => {
        if (args.importer === fileURLToPath(new URL('./worker.mjs', import.meta.url)) || args.importer === nativeAdapter) {
          return { path: resolve(moduleRoot, args.path.slice(3)) };
        }
      });
    } }],
  }).then(output => output.outputFiles[0].text));
  return bundles.get(cacheKey);
}

async function applyMigration(db, path) {
  const sql = await readFile(path, 'utf8');
  await db.batch([
    ...splitSqlQuery(sql).map(statement => db.prepare(statement)),
    db.prepare('INSERT INTO native_schema_migrations(name) VALUES(?)').bind(path.split('/').at(-1)),
  ]);
}

async function count(db, table, condition = '') {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${condition}`).first();
  return row.count;
}

async function effectCounts(db) {
  const queries = {
    orders: count(db, 'native_orders', "WHERE status='placed'"),
    outcomes: count(db, 'native_command_outcomes'), audit: count(db, 'native_audit'),
    paymentIntents: count(db, 'native_payment_intents'),
    snapshots: count(db, 'co_snapshots', "WHERE origin='live' AND published=1"),
    liveReceipts: count(db, 'co_receipts', 'WHERE live=1'),
  };
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([key, result]) => [key, await result])));
}

/** The actual Worker and actual D1, with native numbered migrations and disposable state. */
export async function runtime({ seed = true, moduleRoot = process.env.CO_MODULE_ROOT ?? originalModule, nativeAdapter = process.env.CO_NATIVE_ADAPTER ?? originalAdapter } = {}) {
  moduleRoot = resolve(moduleRoot);
  nativeAdapter = resolve(nativeAdapter);
  const directory = await mkdtemp(join(tmpdir(), 'catalogue-ordering-'));
  let mf;
  try {
    const migrations = join(directory, 'migrations');
    await mkdir(migrations);
    await copyFile(new URL('./fixtures/0001_native.sql', import.meta.url), join(migrations, '0001_native.sql'));
    // This is a real adopter migration copy, never an edited applied migration.
    await writeFile(join(migrations, '0002_catalogue_ordering.sql'), await readFile(join(moduleRoot, 'schema/catalogue-ordering.sql')));
    await copyFile(new URL('./fixtures/0003_populated_upgrade.sql', import.meta.url), join(migrations, '0003_populated_upgrade.sql'));
    mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: await workerBundle(moduleRoot, nativeAdapter),
      compatibilityDate: '2026-09-01', d1Databases: { DB: 'native-catalogue-db' },
    }), resourcePersistencePath: resolve(directory, 'state') });
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE native_schema_migrations(name TEXT PRIMARY KEY)').run();
    await applyMigration(db, join(migrations, '0001_native.sql'));
    if (seed) await seedNative(db);
    await applyMigration(db, join(migrations, '0002_catalogue_ordering.sql'));
    await applyMigration(db, join(migrations, '0003_populated_upgrade.sql'));
    const call = async (path, { actor, input, method = 'POST' } = {}) => {
      const headers = { 'content-type': 'application/json' };
      if (actor) headers.authorization = `Bearer ${actor}`;
      const response = await mf.dispatchFetch(new URL(path, 'https://native-catalogue.test'), {
        method, headers, ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
      });
      if (!response.ok) throw new Error(`Native fixture route ${path} returned ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const request = (actor, operation, input) => operation === 'snapshot'
      ? call(`/snapshot/${encodeURIComponent(input.id)}`, { actor, method: 'GET' })
      : call(`/${operation}`, { actor, input });
    const inspect = async () => {
      const [effects, sessions, memberships, drafts, history, sources] = await Promise.all([
        effectCounts(db), count(db, 'native_sessions'), count(db, 'native_memberships'), count(db, 'co_drafts'),
        db.prepare('SELECT id,body FROM co_snapshots WHERE published=1 ORDER BY id').all(),
        db.prepare('SELECT * FROM co_source_map ORDER BY legacy_id').all(),
      ]);
      return { effects, sessions, memberships, drafts, history: history.results.map(row => ({ id: row.id, snapshot: JSON.parse(row.body) })), sources: sources.results };
    };
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await mf.dispose(); await rm(directory, { recursive: true, force: true }); } };
    return {
      fixture, request, close, inspect, db,
      controls: {
        async changeCommercialFacts() {
          await db.batch([
            db.prepare(`UPDATE native_subjects SET revision=revision+1,terms_revision=terms_revision+1,
              description='Native amended account',delivery='Dock 9 / amended address',configuration='configuration-amended'
              WHERE installation=? AND kind=? AND id=?`).bind(INSTALLATION, fixture.selection.subject.kind, fixture.selection.subject.id),
            db.prepare("UPDATE native_offers SET revision=revision+1,description='Amended native offer',price_coefficient='222222' WHERE installation=? AND id=?").bind(INSTALLATION, fixture.selection.lines[0].offerId),
          ]);
        },
        async setMembership(actor, active) {
          if (!people[actor]) throw new Error('The private control requires a seeded native session');
          await db.prepare('UPDATE native_memberships SET active=?,revision=revision+1 WHERE installation=? AND person_id=? AND subject_kind=? AND subject_id=?')
            .bind(Number(active), INSTALLATION, people[actor], fixture.selection.subject.kind, fixture.selection.subject.id).run();
        },
        async setNativeCommitAllowed(allowed) { await db.prepare('UPDATE native_command_controls SET allowed=? WHERE installation=?').bind(Number(allowed), INSTALLATION).run(); },
        effects: () => effectCounts(db),
        verifyArtifact: artifact => call('/__test/verify', { input: artifact }),
        async restore(artifact) {
          const recovered = await runtime({ seed: false, moduleRoot, nativeAdapter });
          try {
            const result = await recovered.restoreArtifact(artifact);
            return { result, request: recovered.request, inspect: recovered.inspect, close: recovered.close };
          } catch (error) { await recovered.close(); throw error; }
        },
      },
      restoreArtifact: artifact => call('/__test/restore', { input: { installation: INSTALLATION, artifact } }),
    };
  } catch (error) { if (mf) await mf.dispose(); await rm(directory, { recursive: true, force: true }); throw error; }
}
