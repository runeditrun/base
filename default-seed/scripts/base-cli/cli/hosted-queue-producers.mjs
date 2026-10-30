import { RerError } from './errors.mjs';

// Only disposable conformance hosts install these RPC producers. The native
// queue lives behind the fault check, so a rejected send cannot enqueue work.
const producer = `import { WorkerEntrypoint } from 'cloudflare:workers';
let failed = false;
// The default control entrypoint is available only to the host. Application
// bindings use Producer, which exposes only the queue operations below.
export default { fetch(request) { failed = new URL(request.url).pathname === '/fail'; return new Response(null, { status: 204 }); } };
export class Producer extends WorkerEntrypoint {
 async send(body, options) { if (failed) throw new Error('Conformance queue producer failure.'); return this.env.QUEUE.send(body, options); }
 async sendBatch(messages, options) { if (failed) throw new Error('Conformance queue producer failure.'); return this.env.QUEUE.sendBatch(messages, options); }
}`;

export function preparationProducers(options, config) {
 const app = options.workers.find(worker => worker.name === 'app');
 const declared = new Map();
 const validate = binding => {
  if (!declared.has(binding)) throw new RerError('hosted_queue_invalid', 'Queue preparation requires a declared producer binding.', 1);
 };
 for (const [index, item] of (config.queues?.producers ?? []).entries()) {
  const name = `rer-conformance-queue-${index}`;
  declared.set(item.binding, name);
  options.workers.push({ name, modules: true, script: producer, compatibilityDate: config.compatibility_date,
   queueProducers: { QUEUE: item.queue },
  });
  app.serviceBindings[item.binding] = { name, entrypoint: 'Producer' };
 }
 app.queueProducers = {};
 return mf => {
  const control = async (binding, action) => {
   const response = await (await mf.getWorker(declared.get(binding))).fetch('https://queue.invalid/' + action, { method: 'POST' });
   if (!response.ok) throw new RerError('hosted_queue_invalid', 'Disposable queue producer control failed.', 1);
  };
  return Object.freeze({
   fail: binding => { validate(binding); return control(binding, 'fail'); },
   restore: binding => {
    if (binding === undefined) return Promise.all([...declared.keys()].map(name => control(name, 'restore')));
    validate(binding); return control(binding, 'restore');
   },
  });
 };
}
