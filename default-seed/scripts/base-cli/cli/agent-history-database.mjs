import { randomBytes } from 'node:crypto';
import { RerError } from './errors.mjs';
import { FixtureDatabaseError } from '../modules/agent-door/conformance/fixtures.mjs';
import { historyInvalid, isHistoryDeclaration } from './agent-history.mjs';

const installations = new WeakMap();
export const registerHistoryInstallation = (hosted, database) => installations.set(hosted, database);

// The only caller supplies Miniflare's fresh, nonpersistent local databases.
// No URL, database id, provider client or raw prepare capability is accepted
// from fixture output. The ordinary hosted database reader stays SELECT-only.
export async function writeVerificationHistory(hosted, declaration, rows) {
 try {
  if (!installations.has(hosted) || !isHistoryDeclaration(declaration)) throw historyInvalid();
  const database = installations.get(hosted);
  if (!Array.isArray(rows) || rows.length > 1000) throw historyInvalid();
  const batches = new Map(), checked = new Set();
  for (const row of rows) {
   if (!row || Object.keys(row).sort().join(',') !== 'statement,values' || !Array.isArray(row.values)) throw historyInvalid();
   const statement = declaration.statements.get(row.statement);
   if (!statement || row.values.length !== statement.parameters
    || row.values.some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))) throw historyInvalid();
   if (!batches.has(statement.binding)) batches.set(statement.binding, { ...await database(statement.binding), rows: [] });
   const batch = batches.get(statement.binding);
   const key = statement.binding + ':' + statement.table.toLowerCase();
   if (!checked.has(key)) {
    const table = await batch.database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE").bind(statement.table).first();
    const trigger = await batch.database.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='trigger' AND tbl_name=? COLLATE NOCASE").bind(statement.table).first();
    // Refuse every target trigger, rather than trying to parse its transitive
    // effects. INSERT cannot cause foreign-key UPDATE/DELETE cascades.
    if (!table || !/^CREATE TABLE\b/i.test(table.sql) || trigger) throw historyInvalid();
    checked.add(key);
   }
   batch.rows.push({ sql: statement.sql, values: row.values });
  }
  for (const { batch, rows } of batches.values()) if (rows.length) await batch(rows);
 } catch { throw historyInvalid(); }
}

// Both preparation APIs use this one disposable D1 writer. The public phase
// handle exposes individual statements; declared history retains atomic batches
// and its stricter insert-only, trigger-free table checks above.
export function preparationDatabase(db) {
 const refuse = () => { throw new RerError('hosted_database_invalid', new FixtureDatabaseError().message, 1); };
 const check = sql => {
  if (typeof sql !== 'string' || sql.includes(';')) return refuse();
  const readOnly = /^\s*SELECT\b/i.test(sql);
  const target = /^\s*(?:UPDATE\s+|INSERT\s+INTO\s+|DELETE\s+FROM\s+)([a-z_][a-z0-9_]*)\b/i.exec(sql)?.[1];
  if (!readOnly && (!target || /^(?:agent_door_|sqlite_)/i.test(target))) return refuse();
  return { readOnly, target };
 };
 const batch = async rows => {
  try {
   const checked = rows.map(row => ({ ...row, ...check(row.sql) }));
   for (const { target } of checked.filter(row => !row.readOnly)) {
    const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? COLLATE NOCASE").bind(target).first();
    if (!table) return refuse();
   }
   const protectedTables = checked.some(row => !row.readOnly)
    ? (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(substr(name,1,11))='agent_door_'").all()).results : [];
   const guards = protectedTables.flatMap(({ name }) => ['INSERT', 'UPDATE', 'DELETE'].map(event => ({
    name: 'rer_fixture_' + randomBytes(16).toString('hex'), table: name.replaceAll('"', '""'), event,
   })));
   const results = await db.batch([
    ...guards.map(guard => db.prepare(`CREATE TRIGGER "${guard.name}" BEFORE ${guard.event} ON "${guard.table}" BEGIN SELECT RAISE(ABORT, 'fixture protocol write refused'); END`)),
    ...checked.map(({ sql, values }) => db.prepare(sql).bind(...values)),
    ...guards.map(guard => db.prepare(`DROP TRIGGER "${guard.name}"`)),
   ]);
   return results.slice(guards.length, guards.length + checked.length);
  } catch { return refuse(); }
 };
 const statement = (sql, values = []) => {
  check(sql);
  const execute = async () => (await batch([{ sql, values }]))[0];
  return Object.freeze({
   bind: (...bound) => statement(sql, bound), all: execute, run: execute,
   first: async column => { const row = (await execute()).results[0] ?? null; return column === undefined ? row : row?.[column] ?? null; },
   raw: async () => (await execute()).results.map(row => Object.values(row)),
  });
 };
 return { database: Object.freeze({ prepare: sql => statement(sql) }), batch };
}
