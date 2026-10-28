// A real SQLite database behind the D1 SQL interface used by the release probe.
import { DatabaseSync } from 'node:sqlite';

export function database() {
 const native = new DatabaseSync(':memory:');
 native.exec('PRAGMA foreign_keys=ON');
 const statement = (query, values = []) => ({
  query, values, bind(...next) { return statement(query, next); },
  async first() { return native.prepare(query).get(...values) ?? null; },
  async all() { return { results: native.prepare(query).all(...values) }; },
 });
 const db = { prepare: statement, async batch(statements) {
  native.exec('BEGIN');
  try {
   const results = statements.map(s => native.prepare(s.query).all(...s.values));
   native.exec('COMMIT'); return results;
  } catch (error) { native.exec('ROLLBACK'); throw error; }
 } };
 return { native, db };
}

export function targets(canonicalJson) {
 const sql = (sql, ...params) => ({ sql, params });
 return {
  async read(db, destination, kind, id) {
   const row = await db.prepare('SELECT * FROM records WHERE destination=? AND kind=? AND id=?').bind(destination, kind, id).first();
   return row ? { destination, targetKind: kind, targetId: id, revision: row.revision, value: JSON.parse(row.value_json) } : undefined;
  },
  matches(row, destination, kind, id) {
   return row ? sql('EXISTS(SELECT 1 FROM records WHERE destination=? AND kind=? AND id=? AND revision=? AND value_json=?)', destination, kind, id, row.revision, canonicalJson(row.value))
    : sql('NOT EXISTS(SELECT 1 FROM records WHERE destination=? AND kind=? AND id=?)', destination, kind, id);
  },
  write(row) { return [sql('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(destination,kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json', row.destination, row.targetKind, row.targetId, row.revision, canonicalJson(row.value))]; },
  remove(destination, kind, id) { return [sql('DELETE FROM records WHERE destination=? AND kind=? AND id=?', destination, kind, id)]; },
  async list(db, destination) {
   const rows = await db.prepare('SELECT * FROM records WHERE destination=? ORDER BY id').bind(destination).all();
   return rows.results.map(row => ({ destination, targetKind: row.kind, targetId: row.id, revision: row.revision, value: JSON.parse(row.value_json) }));
  },
  matchesCount(count, destination) { return sql('(SELECT COUNT(*) FROM records WHERE destination=?)=?', destination, count); },
 };
}
