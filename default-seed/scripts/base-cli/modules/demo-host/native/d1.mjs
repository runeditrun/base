// The synchronous D1 statement builder stays inside the app isolate. Only SQL
// and bound values cross RPC; a batch remains one SQLite transaction.
export class DemoD1 {
  constructor(sql) { this.sql = sql; }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    if (statements.some(statement => statement.db !== this)) throw new Error('Foreign D1 statement');
    return (await this.sql.batch(statements.map(({ query, args }) => ({ query, args })))).map(result);
  }
  exec(query) { return this.sql.exec(query); }
}
const result = value => ({ success: value.success, results: value.results, meta: value.meta });
class Statement {
  constructor(db, query, args = []) { this.db = db; this.query = query; this.args = args; }
  bind(...args) {
    return new Statement(this.db, this.query, args.map(value => {
      if (typeof value === 'boolean') return Number(value);
      if (value === null || typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
      if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return new Uint8Array(value);
      throw new TypeError('D1_TYPE_ERROR: unsupported bound value');
    }));
  }
  execute() { return this.db.sql.query(this.query, this.args); }
  async all() { return result(await this.execute()); }
  run() { return this.all(); }
  async first(column) {
    const row = (await this.execute()).results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!Object.hasOwn(row, column)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
    return row[column];
  }
  async raw({ columnNames = false } = {}) {
    const { columns, rows } = await this.execute();
    return columnNames ? [columns, ...rows] : rows;
  }
}
