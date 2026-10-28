import { d1Preflight, d1ResultPreflight, createD1RowGuard, d1ColumnCount } from '../../container/adapters/d1-limits.mjs';
const guardRows = createD1RowGuard();
export function sqlite(storage) {
  let lastRowId = 0;
  function query(query, args = []) {
    d1Preflight(query, args, table => d1ColumnCount(table, sql => storage.sql.exec(sql).toArray()));
    const started = performance.now();
    const read = /^\s*(?:SELECT|EXPLAIN)\b/i.test(query);
    const before = read ? 0 : storage.sql.exec('SELECT total_changes() AS n').one().n;
    const cursor = storage.sql.exec(query, ...args);
    const columns = cursor.columnNames;
    const rows = [...cursor.raw()].map(row => row.map(value => value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value));
    const after = read ? { n: 0, id: lastRowId } : storage.sql.exec('SELECT total_changes() AS n, last_insert_rowid() AS id').one();
    d1ResultPreflight(rows);
    if (after.n !== before) guardRows(storage.sql, sql => ({ get: () => storage.sql.exec(sql).toArray()[0], all: () => storage.sql.exec(sql).toArray() }), undefined, query);
    lastRowId = after.id;
    return { success: true, results: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))), columns, rows,
      meta: { duration: performance.now() - started, changes: after.n - before, last_row_id: after.id, changed_db: after.n !== before, rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten,
        size_after: storage.sql.databaseSize, served_by: 'rer-native-demo', served_by_primary: true } };
  }
  return { query: (sql, args) => storage.transactionSync(() => query(sql, args)), batch: statements => storage.transactionSync(() => statements.map(statement => query(statement.query, statement.args))),
    exec(query) { return storage.transactionSync(() => { d1Preflight(query, [], table => d1ColumnCount(table, sql => storage.sql.exec(sql).toArray())); const started = performance.now(); storage.sql.exec(query).toArray(); guardRows(storage.sql, sql => ({ get: () => storage.sql.exec(sql).toArray()[0], all: () => storage.sql.exec(sql).toArray() }), undefined, query); return { count: query.split('\n').filter(line => line.trim()).length, duration: performance.now() - started }; }); } };
}
