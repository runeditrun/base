// The synchronous D1 statement builder stays inside the app isolate. Only SQL
// and bound values cross RPC; a batch remains one SQLite transaction.
export class DemoD1 {
  constructor(sql) { this.sql = sql; return strict(this, 'D1Database'); }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    if (statements.some(statement => statement.db !== this)) throw new Error('Foreign D1 statement');
    return (await d1(() => this.sql.batch(statements.map(({ query, args }) => ({ query, args }))))).map(result);
  }
  exec(query) { return d1(() => this.sql.exec(query), 'D1_EXEC_ERROR'); }
  // One visitor's SQLite has no replicas: every session reads the primary,
  // so any constraint or bookmark is already satisfied.
  withSession(constraintOrBookmark = 'first-unconstrained') {
    if (typeof constraintOrBookmark !== 'string' || !constraintOrBookmark) throw new Error('D1_SESSION_ERROR: invalid constraint or bookmark');
    return strict(new Session(this), 'D1DatabaseSession');
  }
  async dump() { throw failure('D1_DUMP_ERROR', 'dump() is not available in hosted demos'); }
}
class Session {
  constructor(db) { this.db = db; }
  prepare(query) { return this.db.prepare(query); }
  batch(statements) { return this.db.batch(statements); }
  getBookmark() { return '00000000-00000000-00000000-rer-native-demo'; }
}
const result = value => ({ success: value.success, results: value.results, meta: value.meta });
class Statement {
  constructor(db, query, args = []) { this.db = db; this.query = query; this.args = args; return strict(this, 'D1PreparedStatement'); }
  bind(...args) {
    return new Statement(this.db, this.query, args.map(value => {
      if (typeof value === 'boolean') return Number(value);
      if (value === null || typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
      if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return new Uint8Array(value);
      throw failure('D1_TYPE_ERROR', 'Unsupported bound value type');
    }));
  }
  execute() { return d1(() => this.db.sql.query(this.query, this.args)); }
  async all() { return result(await this.execute()); }
  run() { return this.all(); }
  async first(column) {
    const row = (await this.execute()).results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!Object.hasOwn(row, column)) throw new Error('D1_COLUMN_NOTFOUND: Column not found', { cause: new Error('Column not found') });
    return row[column];
  }
  async raw({ columnNames = false } = {}) {
    const { columns, rows } = await this.execute();
    return columnNames ? [columns, ...rows] : rows;
  }
}
// SQL/platform errors may contain seed values. Keep the D1 category only;
// never attach the original exception or its cause to a host-created error.
const failure = (code, message, cause = new Error(message)) => new Error(`${code}: ${message}`, { cause });
async function d1(operation, code = 'D1_ERROR') {
  try { return await operation(); }
  catch { throw failure(code, 'seed-operation-failed [redacted]'); }
}
// An unknown property reads undefined, as on real D1, so feature detection
// takes its fallback. The first read of each unknown name per isolate warns in
// the Worker tail: a seed calling a method this facade lacks inside its own
// queueMicrotask (Slate's read batching) otherwise hangs with no trace.
const warned = new Set();
function strict(target, kind) {
  return new Proxy(target, { get(object, key, receiver) {
    const name = `${kind}.${String(key)}`;
    if (typeof key === 'string' && !(key in object) && key !== 'then' && key !== 'toJSON' && !warned.has(name)) {
      warned.add(name);
      console.warn(`D1_UNSUPPORTED: ${kind} property is not available in hosted demos`);
    }
    return Reflect.get(object, key, receiver);
  } });
}
