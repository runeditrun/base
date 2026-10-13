import { assert, hash } from './validation.mjs';
import { assertMigrationSqlSafe } from './sql-safety.mjs';
import { sqlTokens } from './sql-tokens.mjs';
import { ledger, literal, createLedger, readLedger } from './migration-ledger.mjs';
export function validateMigrations(migrations) {
  let previous = '';
  for (const migration of migrations) {
    assert(/^[0-9]+_[a-zA-Z0-9_-]+\.sql$/.test(migration.name) && migration.name > previous, 'migration-order-or-name'); previous = migration.name;
    assert(typeof migration.sql === 'string' && migration.sql.trim() && hash(migration.sql) === migration.sha256 && migration.sql.length <= 512000, 'invalid-migration-bytes');
    assertMigrationSqlSafe(migration.sql);
    assert(sqlTokens(migration.sql).length > 0, 'invalid-migration-bytes');
  }
}
export async function query(api, id, sql) {
  const rows = await api.request(`/d1/database/${id}/query`,{method:'POST',body:{sql}});
  assert(Array.isArray(rows) && rows.length > 0 && rows.every(x => x.success === true && Array.isArray(x.results)), 'd1-query-failed');
  return rows;
}
export async function migrate(api, id, migrations, { apply = true, upgrade = apply } = {}) {
  validateMigrations(migrations);
  const { applied, transition, exists } = await readLedger(api, id, migrations, query);
  const pending = migrations.slice(applied.length);
  assert(apply || pending.length === 0,'pending-migrations');
  if (transition && upgrade) {
    await api.importSql(id, transition);
    const verified = await readLedger(api, id, migrations, query);
    assert(!verified.transition && verified.applied.length === applied.length, 'migration-readback-mismatch');
  }
  if (pending.length && !exists) await query(api,id,createLedger);
  for (const migration of pending) {
    // Claim before execution. A lost response/partial provider failure is never automatically replayed.
    await query(api,id,`INSERT INTO ${ledger}(name,sha256,state) VALUES (${literal(migration.name)},${literal(migration.sha256)},'applying')`);
    const last = sqlTokens(migration.sql).at(-1);
    // A second terminator after trailing comments creates an empty D1 statement.
    // Keep the newline even when terminated: a final line comment must end.
    const separator = last?.kind === 'symbol' && last.value === ';' ? '' : '; ';
    await api.importSql(id,`${migration.sql}\n${separator}UPDATE ${ledger} SET state='applied' WHERE name=${literal(migration.name)} AND sha256=${literal(migration.sha256)};`);
  }
  if (pending.length) {
    const final = (await query(api,id,`SELECT name, sha256, state FROM ${ledger} ORDER BY id`))[0].results;
    assert(final.length === migrations.length && final.every((x,i) => x.state === 'applied' && x.name === migrations[i].name && x.sha256 === migrations[i].sha256), 'migration-readback-mismatch');
  }
  return { applied:pending.map(x => x.name), history:migrations.map(({name,sha256}) => ({name,sha256})) };
}
