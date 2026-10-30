import native from './native.mjs';
import { WorkerEntrypoint } from 'cloudflare:workers';
export * from './native.mjs';

async function send(env, { binding = 'JOBS', batch = false, id }) {
 try {
  if (batch) await env[binding].sendBatch([{ body: { id: id + '-1' } }, { body: { id: id + '-2' } }]);
  else await env[binding].send({ id }, { contentType: 'json' });
  return { status: 200, outcome: 'queued' };
 } catch { return { status: 503, outcome: 'failed-JOBS' }; }
}

export class QueueProbe extends WorkerEntrypoint {
 send(input) { return send(this.env, input); }
}

export default { ...native,
 async fetch(request, env, ctx) {
  if (new URL(request.url).pathname !== '/fixture/queue') return native.fetch(request, env, ctx);
  const result = await send(env, await request.json());
  return Response.json(result, { status: result.status });
 },
 async queue(batch, env) {
  for (const message of batch.messages) {
   await env.DB.prepare('INSERT INTO fixture_queue_deliveries(id) VALUES(?)').bind(message.body.id).run();
   message.ack();
  }
 },
};
