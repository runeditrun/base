import { historyInvalid, isHistoryDeclaration } from './agent-history.mjs';

const installations = new WeakMap();
export const registerHistoryInstallation = (hosted, mf, databases) => installations.set(hosted, { mf, databases });

// The only caller supplies Miniflare's fresh, nonpersistent local databases.
// No URL, database id, provider client or raw prepare capability is accepted
// from fixture output. The ordinary hosted database reader stays SELECT-only.
export async function writeVerificationHistory(hosted, declaration, rows) {
 try {
  if (!installations.has(hosted) || !isHistoryDeclaration(declaration)) throw historyInvalid();
  const { mf, databases } = installations.get(hosted);
  if (!Array.isArray(rows) || rows.length > 1000) throw historyInvalid();
  const batches = new Map(), checked = new Set();
  for (const row of rows) {
   if (!row || Object.keys(row).sort().join(',') !== 'statement,values' || !Array.isArray(row.values)) throw historyInvalid();
   const statement = declaration.statements.get(row.statement);
   if (!statement || !databases.some(item => item.binding === statement.binding) || row.values.length !== statement.parameters
    || row.values.some(value => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))) throw historyInvalid();
   if (!batches.has(statement.binding)) batches.set(statement.binding, { db: await mf.getD1Database(statement.binding, 'app'), rows: [] });
   const batch = batches.get(statement.binding);
   const key = statement.binding + ':' + statement.table.toLowerCase();
   if (!checked.has(key)) {
    const table = await batch.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE").bind(statement.table).first();
    const trigger = await batch.db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='trigger' AND tbl_name=? COLLATE NOCASE").bind(statement.table).first();
    // Refuse every target trigger, rather than trying to parse its transitive
    // effects. INSERT cannot cause foreign-key UPDATE/DELETE cascades.
    if (!table || !/^CREATE TABLE\b/i.test(table.sql) || trigger) throw historyInvalid();
    checked.add(key);
   }
   batch.rows.push(batch.db.prepare(statement.sql).bind(...row.values));
  }
  for (const { db, rows } of batches.values()) if (rows.length) await db.batch(rows);
 } catch { throw historyInvalid(); }
}
