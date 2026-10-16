import { env } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DemoD1 } from './d1.js';
import { DemoR2 } from './r2-client.js';
import { DemoNamespace } from './namespace.js';

// Seed DOs use RPC rather than another object's SQL storage handle.
export const localSQL = new AsyncLocalStorage();
const config = env.RER_NATIVE_CONFIG;
for (const binding of config.databases) {
  const call = (method, ...args) => {
    const sql = localSQL.getStore();
    return sql && binding === config.databases[0]
      ? sql[method](...args) : env.RER_NATIVE_HOST.database(binding, method, args);
  };
  env[binding] = new DemoD1({ query: (...args) => call('query', ...args), batch: (...args) => call('batch', ...args), exec: (...args) => call('exec', ...args) });
}
for (const binding of config.buckets) env[binding] = new DemoR2(env.RER_NATIVE_HOST, binding);
for (const { binding, queue } of config.queues.producers) env[binding] = {
  metrics: () => env.RER_NATIVE_HOST.queueMetrics(queue),
  send: (body, options = {}) => env.RER_NATIVE_HOST.enqueue(queue, [{ body, ...options }]),
  sendBatch: (messages, options = {}) => env.RER_NATIVE_HOST.enqueue(queue, Array.from(messages).map(message => ({ ...options, ...message }))),
};
for (const { name } of config.objects) env[name] = new DemoNamespace(env.RER_NATIVE_HOST, name, env.RER_NATIVE_KEY);
