import { DurableObject } from 'cloudflare:workers';

// One per demo Worker (idFromName('capacity')): the running demos and their
// ends. A start is admitted while fewer than max_instances demos are live; a
// demo releases its place when it ends, and a place past its end is free anyway.
export class DemoCapacity extends DurableObject {
  async record(correlation, diagnostic) {
    const records = await this.ctx.storage.get('diagnostics') ?? [];
    const now = Date.now();
    const recent = records.filter(record => record.expires > now).slice(-31);
    recent.push({ correlation, expires: now + 15 * 60_000, diagnostic });
    await this.ctx.storage.put('diagnostics', recent);
    await this.ctx.storage.setAlarm(now + 15 * 60_000);
  }
  async diagnostic(correlation) {
    const records = await this.ctx.storage.get('diagnostics') ?? [];
    return records.find(record => record.correlation === correlation && record.expires > Date.now())?.diagnostic ?? null;
  }
  async alarm() { await this.ctx.storage.deleteAll(); }

  async acquire(id, ends, max) {
    const now = Date.now(), places = await this.ctx.storage.list();
    const over = [...places].filter(([, until]) => until <= now).map(([key]) => key);
    if (over.length) await this.ctx.storage.delete(over);
    if (places.size - over.length >= max) return false;
    await this.ctx.storage.put(id, ends);
    return true;
  }

  async release(id) {
    await this.ctx.storage.delete(id);
  }
}
