import { DurableObject } from 'cloudflare:workers';

// One per demo Worker (idFromName('capacity')): the running demos and their
// ends. A start is admitted while fewer than max_instances demos are live; a
// demo releases its place when it ends, and a place past its end is free anyway.
export class DemoCapacity extends DurableObject {
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
