import { env, DurableObject } from 'cloudflare:workers';
import { DemoD1 } from './d1.js';
import { sqlite } from './sql.js';

let ready;
function application() {
  if (!ready) {
    // Set the facade before evaluating the seed, including cloudflare:workers
    // imports in its dependencies and withDemo's module-level environment.
    ready = import('__RER_APP_ENTRY__');
  }
  return ready;
}
export class DemoApp extends DurableObject {
  constructor(ctx, bindings) {
    super(ctx, bindings);
    this.sql = sqlite(ctx.storage);
    env[env.RER_NATIVE_DB] = new DemoD1(this.sql);
  }
  query(query, args) { return this.sql.query(query, args); }
  batch(statements) { return this.sql.batch(statements); }
  exec(query) { return this.sql.exec(query); }
  async fetch(request) { return (await application()).default.fetch(request, env, this.ctx); }
  async runScheduled(scheduledTime, cron) {
    const app = (await application()).default;
    if (app.scheduled) await app.scheduled({ scheduledTime, cron, noRetry() {} }, env, this.ctx);
  }
}
