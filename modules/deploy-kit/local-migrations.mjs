import { createHash } from 'node:crypto';
import { assertMigrationSqlSafe } from '../deploy-kit/sql-safety.mjs';
import { sqlTokens } from '../deploy-kit/sql-tokens.mjs';
import { recorded } from '../deploy-kit/migration-ledger.mjs';
function validateMigrations(migrations) {
 const names = new Set();
 for (const migration of migrations) {
  if (!/^[\w.-]+\.sql$/.test(migration.name) || names.has(migration.name)) throw new Error('migration-order-or-name');
  names.add(migration.name);
  if (typeof migration.sql !== 'string' || !migration.sql.trim() || Buffer.byteLength(migration.sql) > 10*1024*1024 || createHash('sha256').update(migration.sql).digest('hex') !== migration.sha256 || !sqlTokens(migration.sql).length) throw new Error('invalid-migration-bytes');
  assertMigrationSqlSafe(migration.sql);
  if (migration.rewrites !== undefined && (!Array.isArray(migration.rewrites) || !migration.rewrites.every(rewrite => /^[a-f0-9]{64}$/.test(rewrite?.from ?? '') && rewrite.from !== migration.sha256 && typeof rewrite.reason === 'string' && rewrite.reason.trim()))) throw new Error('invalid-migration-rewrite');
 }
}
export async function migrate(db, migrations, { ledger = '_rer_deploy_migrations' } = {}) {
 if (!['_rer_deploy_migrations', '_rer_portability_migrations'].includes(ledger)) throw new Error('Invalid migration ledger');
 validateMigrations(migrations);
 await db.prepare(`CREATE TABLE IF NOT EXISTS ${ledger}(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('applying','applied')))`).run();
 // The producer preserves declared directory order, including prefixes. Rowid
 // preserves application order without changing the existing ledger schema.
 const history = (await db.prepare(`SELECT name,sha256,state FROM ${ledger} ORDER BY rowid`).all()).results;
 if (history.some((row, i) => !recorded(row, migrations[i]) || row.state !== 'applied')) throw new Error('changed-or-uncertain-migration-history');
 const legacy = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'").first();
 if (ledger === '_rer_deploy_migrations' && legacy && (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.some(row => !history.some(prior => prior.name === row.name))) throw new Error('legacy-migration-history-needs-reviewed-hash-adoption');
 for (const migration of migrations.slice(history.length)) {
  await db.prepare(`INSERT INTO ${ledger} VALUES(?,?,'applying')`).bind(migration.name, migration.sha256).run();
  // A claim commits separately. Application and completion share one transaction.
  await db.batch([...migration.statements.map(sql => db.prepare(sql)), db.prepare(`UPDATE ${ledger} SET state='applied' WHERE name=? AND sha256=? AND state='applying'`).bind(migration.name, migration.sha256)]);
 }
 return { applied: migrations.length, pending: 0 };
}
