import { bundle } from './loader.mjs';

export async function seedAlarm(host, binding, id, method, at) {
  await host.active();
  if (!bundle.bindings.objects.some(item => item.name === binding) || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Unknown Durable Object binding or id');
  const key = `alarm:${binding}:${id}`;
  if (method === 'get') {
    const record = await host.ctx.storage.get(key);
    return record && !record.firing ? record.at : null;
  }
  if (method === 'delete') { await host.ctx.storage.delete(key); return; }
  if (method !== 'set' || !Number.isFinite(at) || at <= 0) throw new TypeError('Invalid Durable Object alarm time');
  await host.ctx.storage.put(key, { binding, id, at: Math.max(Date.now(), at), token: crypto.randomUUID(), attempts: 0 });
  await host.schedule(at);
}
export async function nextSeedAlarm(host) {
  return Math.min(Infinity, ...[...(await host.ctx.storage.list({ prefix: 'alarm:' })).values()].map(item => item.at));
}
export async function deliverSeedAlarms(host, now) {
  const records = await host.ctx.storage.list({ prefix: 'alarm:' });
  for (const [key, record] of records) {
    if (record.at > now) continue;
    const claimed = await host.ctx.storage.transaction(async txn => {
      const current = await txn.get(key);
      if (current?.token !== record.token) return false;
      // Persist a retry before invoking the seed, so an interrupted delivery is
      // retried too. A seed's set/delete during delivery supersedes this token.
      await txn.put(key, { ...record, firing: true, at: Date.now() + 2000 * 2 ** record.attempts, attempts: record.attempts + 1 });
      return true;
    });
    if (!claimed) continue;
    let failed = false;
    try {
      const response = await host.object(record.binding, record.id, 'fetch', [new Request('https://native.invalid/alarm', { headers: {
        'x-rer-native-alarm-key': host.state.runtime.RER_NATIVE_KEY,
        'x-rer-native-alarm-info': JSON.stringify({ retryCount: record.attempts, isRetry: record.attempts > 0 }),
      } })]);
      if (response.status !== 204) throw new Error(`Seed alarm refused: ${response.status}`);
    }
    catch {
      failed = true;
      console.error(JSON.stringify({ event: 'native-demo-seed-alarm-failed', binding: record.binding, message: host.failure() }));
    }
    await host.ctx.storage.transaction(async txn => {
      const current = await txn.get(key);
      if (current?.token !== record.token) return;
      if (failed && current.attempts <= 6) await txn.put(key, { ...current, firing: false });
      else await txn.delete(key);
    });
  }
}
