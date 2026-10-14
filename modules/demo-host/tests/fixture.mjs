// The front Worker as deployed, with the container platform (the paid edge)
// replaced: each demo's "container" is the test's APP service, told which
// demo is calling. TEST_IDLE_MS shortens the idle end.
export { default, DemoCapacity } from '../worker.mjs';
import { DemoContainer as Deployed } from '../container.mjs';

export class DemoContainer extends Deployed {
  idle = Number(this.env.TEST_IDLE_MS ?? this.idle);
  get container() { return this.platform ??= platform(this.env.APP, this.ctx.id.toString()); }
}

function platform(app, id) {
  let running = false;
  const tell = (what, body) => app.fetch(`http://platform/${what}`, { method: 'POST', headers: { 'x-demo': id }, body: JSON.stringify(body) });
  return {
    get running() { return running; },
    start(options) { running = true; void tell('start', options); },
    monitor: () => new Promise(() => {}),
    async destroy() { running = false; await tell('destroy', {}); },
    // As on the platform, a container's port speaks plain HTTP only.
    getTcpPort: () => ({ fetch(input, init) {
      const request = new Request(input, init);
      if (new URL(request.url).protocol !== 'http:') throw new TypeError('Connecting to a container using HTTPS is not currently supported');
      request.headers.set('x-demo', id);
      return app.fetch(request);
    } }),
  };
}
