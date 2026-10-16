export function sqlite(storage) {
  function query(query, args = []) {
    const started = performance.now();
    const before = storage.sql.exec('SELECT total_changes() AS n').one().n;
    const cursor = storage.sql.exec(query, ...args);
    const columns = cursor.columnNames;
    const rows = [...cursor.raw()].map(row => row.map(value => value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value));
    const after = storage.sql.exec('SELECT total_changes() AS n, last_insert_rowid() AS id').one();
    return { success: true, results: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))), columns, rows,
      meta: { duration: performance.now() - started, changes: after.n - before, last_row_id: after.id, changed_db: after.n !== before, rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten } };
  }
  return { query, batch: statements => storage.transactionSync(() => statements.map(statement => query(statement.query, statement.args))),
    exec(query) { const started = performance.now(); storage.sql.exec(query).toArray(); return { count: query.split('\n').filter(line => line.trim()).length, duration: performance.now() - started }; } };
}
