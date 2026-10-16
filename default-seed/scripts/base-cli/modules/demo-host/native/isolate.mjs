// Bindings must exist before evaluating the seed's cloudflare:workers imports.
import { localSQL } from './bindings.js';
import { env, DurableObject } from 'cloudflare:workers';
import * as application from '__RER_APP_ENTRY__';
import { sqlite } from './sql.js';

export class DemoDatabase extends DurableObject {
  constructor(ctx, bindings) { super(ctx, bindings); this.sql = sqlite(ctx.storage); }
  query(query, args) { return this.sql.query(query, args); }
  batch(statements) { return this.sql.batch(statements); }
  exec(query) { return this.sql.exec(query); }
}
export class DemoApp extends DemoDatabase {
  async fetch(request) { return localSQL.run(this.sql, () => application.default.fetch(request, env, this.ctx)); }
  async runScheduled(scheduledTime, cron) {
    if (application.default.scheduled) await localSQL.run(this.sql, () => application.default.scheduled({ scheduledTime, cron, noRetry() {} }, env, this.ctx));
  }
  async runQueue(queue, messages) {
    if (!application.default.queue) throw new Error(`Seed has no queue() handler for ${queue}`);
    const outcomes = new Map(), waits = [];
    const settle = (id, retry, options = {}) => { if (!outcomes.has(id)) outcomes.set(id, { id, retry, delaySeconds: options.delaySeconds }); };
    const batch = { queue, messages: messages.map(message => ({ ...message, timestamp: new Date(message.timestamp),
      ack: () => settle(message.id, false), retry: options => settle(message.id, true, options) })),
      ackAll: () => messages.forEach(message => settle(message.id, false)),
      retryAll: options => messages.forEach(message => settle(message.id, true, options)),
    };
    let failed = false;
    try {
      await localSQL.run(this.sql, async () => {
        await application.default.queue(batch, env, { waitUntil: promise => waits.push(promise), passThroughOnException() {} });
        await Promise.all(waits);
      });
    } catch { failed = true; }
    return messages.map(message => outcomes.get(message.id) ?? { id: message.id, retry: failed });
  }
}
