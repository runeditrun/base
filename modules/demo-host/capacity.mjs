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
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now(), places = [...await storage.list()]
        .filter(([key, until]) => /^[0-9a-f]{64}$/.test(key) && typeof until === 'number');
      const expired = places.filter(([, until]) => until <= now).map(([key]) => key);
      if (expired.length) await storage.delete(expired);
      const held = places.filter(([key, until]) => key !== id && until > now);
      if (held.length >= max) {
        // Fingerprints identify held reservations without logging bearer cookies.
        const heldIds = await Promise.all(held.map(async ([key, until]) => ({ id: await fingerprint(key), ends: until })));
        console.log(JSON.stringify({ event: 'demo_capacity_refused', max, held: heldIds }));
        return false;
      }
      await storage.put(id, ends);
      return true;
    });
  }

  async extend(id, ends) {
    return this.ctx.storage.transaction(async storage => {
      if (!((await storage.get(id)) > Date.now())) return false;
      await storage.put(id, ends);
      return true;
    });
  }

  async release(id) {
    await this.ctx.storage.delete(id);
  }
}

export async function fingerprint(id) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
