import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite';
import { d1Preflight, d1NativeLimits, d1ResultPreflight, guardD1Rows, d1ColumnCount } from './d1-limits.mjs';

/** A local D1 stand-in, not a replacement for independent SQLite storage.
 * Native options are passed on every open, including reopen and read-only
 * proof connections. Node 22 enforces through the shared preflight instead.
 */
export class DatabaseSync extends NativeDatabaseSync {
  constructor(path, options = {}) {
    super(path, { ...options, limits: d1NativeLimits });
    // SQL can derive a pattern from a column or another function. Check its
    // evaluated bytes before SQLite compiles the pattern, then delegate to
    // SQLite's own matching semantics on an isolated native connection.
    this.patterns = new NativeDatabaseSync(':memory:', { limits: d1NativeLimits });
    for (const name of ['like', 'glob']) {
      const statements = new Map();
      this.function(name, { varargs: true, deterministic: true, useBigIntArguments: true }, (...args) => {
        const sql = `SELECT ${name}(${args.map(() => '?').join(',')}) AS value`;
        d1Preflight(sql, args);
        if (!statements.has(args.length)) statements.set(args.length, this.patterns.prepare(sql));
        return statements.get(args.length).get(...args).value;
      });
    }
  }
  close() { try { return super.close(); } finally { this.patterns.close(); } }
  preflight(sql, args = []) { d1Preflight(sql, args, table => d1ColumnCount(table, text => NativeDatabaseSync.prototype.prepare.call(this, text).all(), 'table_xinfo')); }
  guard() { guardD1Rows(this, sql => super.prepare(sql), sql => super.exec(sql)); }
  exec(sql) { this.preflight(sql); this.guard(); const result = super.exec(sql); this.guard(); return result; }
  prepare(sql) {
    this.preflight(sql);
    this.guard();
    const statement = super.prepare(sql);
    let proxy;
    const db = this;
    proxy = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (['run', 'get', 'all', 'iterate'].includes(key)) { db.guard(); db.preflight(sql, args); }
        const checked = ['get', 'all'].includes(key) && /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
        const exec = sql => NativeDatabaseSync.prototype.exec.call(db, sql);
        if (checked) exec('SAVEPOINT rer_d1_result');
        try {
          const result = value.apply(target, args);
          if (key === 'iterate') return (function* () {
            for (const row of result) { d1ResultPreflight([row]); yield row; }
          })();
          if (checked) { d1ResultPreflight(key === 'get' ? result ? [result] : [] : result); exec('RELEASE rer_d1_result'); }
          return result === target ? proxy : result;
        } catch (error) {
          if (checked) { exec('ROLLBACK TO rer_d1_result'); exec('RELEASE rer_d1_result'); }
          throw error;
        }
      };
    } });
    return proxy;
  }
}
