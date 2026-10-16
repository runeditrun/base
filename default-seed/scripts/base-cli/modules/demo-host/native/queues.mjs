import { application, bundle } from './loader.mjs';
const consumerFor = queue => bundle.bindings.queues.consumers.find(item => item.queue === queue);
export async function enqueue(host, queue, messages) {
  await host.active();
  if (!bundle.bindings.queues.producers.some(item => item.queue === queue)) throw new Error(`Unknown queue: ${queue}`);
  if (!Array.isArray(messages) || !messages.length || messages.length > 100) throw new Error('Queue batch must contain 1–100 messages');
  const now = Date.now(), records = {};
  for (const message of messages) {
    const type = message.contentType ?? 'json';
    if (!['json', 'text', 'bytes', 'v8'].includes(type)) throw new TypeError('Unknown queue contentType');
    const body = type === 'json' ? JSON.parse(JSON.stringify(message.body)) : message.body;
    if (type === 'text' && typeof body !== 'string') throw new TypeError('Queue text body must be a string');
    const delay = message.delaySeconds ?? consumerFor(queue)?.delivery_delay ?? 0;
    if (!Number.isInteger(delay) || delay < 0 || delay > 43200) throw new TypeError('Invalid queue delaySeconds');
    const id = crypto.randomUUID();
    records[`queue:${id}`] = { id, queue, body, timestamp: now, attempts: 0, at: now + Math.max(delay * 1000, Math.min(1000, (consumerFor(queue)?.max_batch_timeout ?? 1) * 1000)) };
  }
  await host.ctx.storage.put(records);
  await host.schedule(Math.min(...Object.values(records).map(item => item.at)));
  return { metadata: { metrics: await queueMetrics(host, queue) } };
}
export async function deliverQueues(host, now) {
  const records = await host.ctx.storage.list({ prefix: 'queue:' });
  const groups = new Map();
  for (const message of records.values()) if (message.at <= now) {
    if (!groups.has(message.queue)) groups.set(message.queue, []);
    groups.get(message.queue).push(message);
  }
  for (const [queue, pending] of groups) {
    const consumer = consumerFor(queue) ?? {}, size = consumer.max_batch_size ?? 10;
    // Bound alarm work. Undelivered batches retain their original durable records.
    const messages = pending.slice(0, size).map(message => ({ ...message, attempts: message.attempts + 1 }));
    let outcomes;
    try { outcomes = await application(host.env, host.ctx, host.ctx.id.toString(), host.state.runtime).runQueue(queue, messages); }
    catch { outcomes = messages.map(message => ({ id: message.id, retry: true })); }
    console.log(JSON.stringify({ event: 'native-demo-queue', correlation: host.state?.correlation, queue, messages: messages.length, acknowledged: outcomes.filter(item => !item.retry).length }));
    for (const message of messages) {
      if (!host.state || host.state.phase !== 'ready') return;
      const result = outcomes.find(item => item.id === message.id);
      if (result && !result.retry) await host.ctx.storage.delete(`queue:${message.id}`);
      else if (message.attempts <= (consumer.max_retries ?? 3)) {
        message.at = Date.now() + (result?.delaySeconds ?? consumer.retry_delay ?? Math.min(60, 2 ** message.attempts)) * 1000;
        await host.ctx.storage.put(`queue:${message.id}`, message);
      } else if (consumer.dead_letter_queue) {
        const target = consumer.dead_letter_queue;
        await host.ctx.storage.put(`queue:${message.id}`, { ...message, queue: target, attempts: 0, at: consumerFor(target) ? Date.now() : Number.MAX_SAFE_INTEGER });
      } else await host.ctx.storage.delete(`queue:${message.id}`);
    }
  }
}
export async function nextQueue(host) {
  return Math.min(Infinity, ...[...(await host.ctx.storage.list({ prefix: 'queue:' })).values()].map(item => item.at));
}

export async function queueMetrics(host, queue) {
  await host.active();
  if (!bundle.bindings.queues.producers.some(item => item.queue === queue)) throw new Error(`Unknown queue: ${queue}`);
  const messages = [...(await host.ctx.storage.list({ prefix: 'queue:' })).values()].filter(item => item.queue === queue);
  const bytes = body => body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body.byteLength : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).byteLength;
  return { backlogCount: messages.length, backlogBytes: messages.reduce((sum, item) => sum + bytes(item.body), 0),
    ...(messages.length ? { oldestMessageTimestamp: new Date(Math.min(...messages.map(item => item.timestamp))) } : {}) };
}
