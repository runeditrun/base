import { fail, sum, canonical } from './policy.mjs';
const counters = ['calls','units','microUsd'];
/** Synchronous SQLite transactions only; no provider or object-store work here. */
export class Ledger {
  constructor(storage) {
    this.storage = storage;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ai_state (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, frozen INTEGER NOT NULL DEFAULT 0)`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ai_operations (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, purpose TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, second_digest TEXT, object_digest TEXT, object_mime TEXT)`);
    storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ai_image_purpose ON ai_operations(tenant,purpose) WHERE kind='image'`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ai_calls (operation TEXT NOT NULL, child INTEGER NOT NULL, fence TEXT NOT NULL, status TEXT NOT NULL, calls INTEGER NOT NULL, units INTEGER NOT NULL, microUsd INTEGER NOT NULL, PRIMARY KEY(operation,child))`);
  }
  rows(sql, ...args) { return [...this.storage.sql.exec(sql, ...args)]; }
  one(sql, ...args) { return this.rows(sql, ...args)[0]; }
  transaction(fn) { return this.storage.transactionSync(fn); }
  bind(policy) {
    const current = canonical({ installation:policy.installation,environment:policy.environment,custody:policy.custody,revision:policy.revision, policy });
    const frozen = this.transaction(() => {
      const row = this.one('SELECT * FROM ai_state WHERE id=1');
      if (!row) this.storage.sql.exec('INSERT INTO ai_state(id,policy) VALUES(1,?)', current);
      else if (row.policy !== current) { this.storage.sql.exec('UPDATE ai_state SET frozen=1 WHERE id=1'); return true; }
      return !!row?.frozen;
    });
    if (frozen) fail('ai_reconciliation_required');
  }
  totals() { return this.one('SELECT coalesce(sum(calls),0) calls,coalesce(sum(units),0) units,coalesce(sum(microUsd),0) microUsd FROM ai_calls'); }
  operation(id) { return this.one('SELECT * FROM ai_operations WHERE id=?', id); }
  findImage(tenant, purpose) { return this.one("SELECT * FROM ai_operations WHERE tenant=? AND purpose=? AND kind='image'", tenant, purpose); }
  calls(id) { return this.rows('SELECT * FROM ai_calls WHERE operation=? ORDER BY child', id); }
  reserve({id,tenant,purpose,kind,digest}, maxima, limit) {
    return this.transaction(() => {
      const previous = kind === 'image' ? this.findImage(tenant,purpose) : this.operation(id);
      if (previous) {
        if (previous.tenant !== tenant || previous.purpose !== purpose || previous.kind !== kind || previous.digest !== digest) fail('ai_operation_conflict');
        return { operation:previous, fresh:false };
      }
      if (this.one('SELECT frozen FROM ai_state WHERE id=1')?.frozen) fail('ai_reconciliation_required');
      const total = this.totals();
      for (const k of counters) if (sum(total[k], ...maxima.map(m => m[k])) > limit[k]) fail('ai_budget_exhausted', 402);
      this.storage.sql.exec('INSERT INTO ai_operations(id,tenant,purpose,kind,digest) VALUES(?,?,?,?,?)', id,tenant,purpose,kind,digest);
      maxima.forEach((m, i) => this.storage.sql.exec("INSERT INTO ai_calls(operation,child,fence,status,calls,units,microUsd) VALUES(?,?,?,'reserved',?,?,?)", id,i,crypto.randomUUID(),m.calls,m.units,m.microUsd));
      return { operation:this.operation(id), fresh:true };
    });
  }
  second(id, hash) {
    this.transaction(() => {
      const row = this.operation(id);
      if (row.second_digest && row.second_digest !== hash) fail('ai_operation_conflict');
      this.storage.sql.exec('UPDATE ai_operations SET second_digest=? WHERE id=?',hash,id);
    });
  }
  async dispatch(id, child) {
    const winner = this.transaction(() => {
      if (this.one('SELECT frozen FROM ai_state WHERE id=1')?.frozen) fail('ai_reconciliation_required');
      return this.one("UPDATE ai_calls SET status='dispatching' WHERE operation=? AND child=? AND status='reserved' RETURNING fence", id,child);
    });
    // Paid effects must not leave before the write is durable (including SQLite output gates).
    await this.storage.sync();
    return winner?.fence;
  }
  uncertain(id, child, fence) { this.storage.sql.exec("UPDATE ai_calls SET status='uncertain' WHERE operation=? AND child=? AND fence=? AND status='dispatching'", id,child,fence); }
  releaseUnsent(id) { this.storage.sql.exec("UPDATE ai_calls SET status='unsent',calls=0,units=0,microUsd=0 WHERE operation=? AND status='reserved'", id); }
  settle(id, child, fence, actual) {
    return this.transaction(() => {
      const old = this.one('SELECT * FROM ai_calls WHERE operation=? AND child=? AND fence=?', id,child,fence);
      if (!old || !['dispatching','uncertain'].includes(old.status)) return;
      if (counters.some(k => actual[k] > old[k])) this.storage.sql.exec('UPDATE ai_state SET frozen=1 WHERE id=1');
      this.storage.sql.exec("UPDATE ai_calls SET status='settled',calls=?,units=?,microUsd=? WHERE operation=? AND child=? AND fence=?", actual.calls,actual.units,actual.microUsd,id,child,fence);
    });
  }
  object(id, digest, mime) { this.storage.sql.exec('UPDATE ai_operations SET object_digest=?,object_mime=? WHERE id=?', digest,mime,id); }
  snapshot() { return { totals:this.totals(), frozen:!!this.one('SELECT frozen FROM ai_state WHERE id=1')?.frozen, operations:this.rows('SELECT * FROM ai_operations'), calls:this.rows('SELECT * FROM ai_calls') }; }
}
