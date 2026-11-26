// Bindings must exist before evaluating the seed's cloudflare:workers imports.
import { localSQL } from './bindings.js';
import { env, DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import * as application from '__RER_APP_ENTRY__';
import { sqlite } from './sql.js';

// The seed's handlers get a Workers ExecutionContext. ctx.exports holds the
// seed's named WorkerEntrypoint classes as loopback stubs (exports.Name({ props })
// runs each method on a new instance with those props and env) and its Durable
// Object classes as the host binds them. A name the seed does not export is
// absent, so calling it throws as on Workers.
const entrypoints = Object.entries(application).filter(([, value]) => typeof value === 'function' && value.prototype instanceof WorkerEntrypoint);
function context(waitUntil, props = {}) {
  const exports = {};
  for (const [name, Entrypoint] of entrypoints) exports[name] = ({ props = {} } = {}) => new Proxy({}, { get(_, method) {
    if (typeof method !== 'string' || method === 'constructor' || method in Object.prototype || typeof Entrypoint.prototype[method] !== 'function') return undefined;
    return async (...args) => new Entrypoint(context(waitUntil, props), env)[method](...args);
  } });
  for (const { name, class_name } of env.RER_NATIVE_CONFIG.objects) exports[class_name] = env[name];
  return { waitUntil, passThroughOnException() {}, props, exports };
}
// Runs a scheduled or queue handler and the work it hands to waitUntil.
async function settled(run) {
  const waits = [];
  await run(context(promise => waits.push(promise)));
  await Promise.all(waits);
}

export class DemoDatabase extends DurableObject {
  constructor(ctx, bindings) { super(ctx, bindings); this.sql = sqlite(ctx.storage); }
  query(query, args) { return this.sql.query(query, args); }
  batch(statements) { return this.sql.batch(statements); }
  exec(query) { return this.sql.exec(query); }
}
export class DemoApp extends DemoDatabase {
  async fetch(request) { return localSQL.run(this.sql, () => application.default.fetch(request, env, context(promise => this.ctx.waitUntil(promise)))); }
  async runScheduled(scheduledTime, cron) {
    if (application.default.scheduled) await localSQL.run(this.sql, () => settled(ctx => application.default.scheduled({ scheduledTime, cron, noRetry() {} }, env, ctx)));
  }
  async runQueue(queue, messages) {
    if (!application.default.queue) throw new Error(`Seed has no queue() handler for ${queue}`);
    const outcomes = new Map();
    const settle = (id, retry, options = {}) => { if (!outcomes.has(id)) outcomes.set(id, { id, retry, delaySeconds: options.delaySeconds }); };
    const batch = { queue, messages: messages.map(message => ({ ...message, timestamp: new Date(message.timestamp),
      ack: () => settle(message.id, false), retry: options => settle(message.id, true, options) })),
      ackAll: () => messages.forEach(message => settle(message.id, false)),
      retryAll: options => messages.forEach(message => settle(message.id, true, options)),
    };
    let failed = false;
    try { await localSQL.run(this.sql, () => settled(ctx => application.default.queue(batch, env, ctx))); }
    catch { failed = true; }
    return messages.map(message => outcomes.get(message.id) ?? { id: message.id, retry: failed });
  }
}
