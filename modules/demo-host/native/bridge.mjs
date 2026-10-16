import { WorkerEntrypoint } from 'cloudflare:workers';

// Only visitor-local resource operations cross into the loaded seed.
export class HostBridge extends WorkerEntrypoint {
  #host() { return this.env.DEMO.get(this.env.DEMO.idFromString(this.ctx.props.id)); }
  database(binding, method, args) { return this.#host().database(binding, method, args); }
  object(binding, id, method, args) { return this.#host().object(binding, id, method, args); }
  r2(binding, method, args) { return this.#host().r2(binding, method, args); }
  enqueue(queue, messages) { return this.#host().enqueue(queue, messages); }
  queueMetrics(queue) { return this.#host().queueMetrics(queue); }
  seedAlarm(binding, id, method, at) { return this.#host().seedAlarm(binding, id, method, at); }
  fetch(request) {
    // The host validates the visitor key and removes the routing headers.
    if (!request.headers.has('x-rer-native-object') || request.headers.get('x-rer-native-key') !== this.ctx.props.key) return new Response('Not found.', { status: 404 });
    return this.#host().fetch(request);
  }
}
