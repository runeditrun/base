// The front Worker as deployed, with the container platform (the paid edge)
// replaced: each demo's "container" is the test's APP service, told which
// demo is calling. TEST_IDLE_MS shortens the idle end. With TEST_EVICT_MS the
// platform evicts an object that has had no event in flight for that long and
// stops its container, and the evicted object's exit watcher is lost with it.
export { default, DemoCapacity } from '../worker.mjs';
import { DemoContainer as Deployed } from '../container.mjs';

export class DemoContainer extends Deployed {
  cleanupRetry = Number(this.env.TEST_CLEANUP_MS ?? this.cleanupRetry);
  startTimeout = Number(this.env.TEST_START_MS ?? this.startTimeout);
  probeTimeout = Number(this.env.TEST_PROBE_MS ?? this.probeTimeout);
  idle = Number(this.env.TEST_IDLE_MS ?? this.idle);
  get container() { return this.platform ??= platform(this.env.APP, this.ctx.id.toString(), Number(this.env.TEST_PLACEMENT_FAILURES)); }
  events = 0;
  async event(run) {
    if (this.events++ === 0 && this.env.TEST_EVICT_MS && Date.now() - this.quiet >= Number(this.env.TEST_EVICT_MS)) this.container.evict();
    try { return await run(); } finally { if (--this.events === 0) this.quiet = Date.now(); }
  }
  fetch(request) { return this.event(() => super.fetch(request)); }
  alarm() { return this.event(() => super.alarm()); }
  start(options) { return this.event(() => super.start(options)); }
  end() { return this.event(() => super.end()); }
  diagnostic() { return this.event(() => super.diagnostic()); }
}

function platform(app, id, failures) {
  let running = false, exit;
  let stopped;
  const tell = (what, body) => app.fetch(`http://platform/${what}`, { method: 'POST', headers: { 'x-demo': id }, body: JSON.stringify(body) });
  return {
    get running() { return running; },
    start(options) {
      stopped = new Promise((_, reject) => { exit = reject; });
      running = true;
      if (failures-- > 0) {
        running = false;
        queueMicrotask(() => exit(new Error('There is no container instance that can be provided to this Durable Object, try again later')));
      } else void tell('start', options);
    },
    monitor: () => stopped,
    async destroy() { const response = await tell('destroy', {}); if (!response.ok) throw new Error('SECRET destroy'); running = false; },
    evict() { if (running) { running = false; void tell('stopped', {}); } },
    // As on the platform, a container's port speaks plain HTTP only.
    getTcpPort: () => ({ async fetch(input, init) {
      const request = new Request(input, init);
      if (new URL(request.url).protocol !== 'http:') throw new TypeError('Connecting to a container using HTTPS is not currently supported');
      if (!running) throw new TypeError('SECRET the container is not running');
      request.headers.set('x-demo', id);
      const response = await app.fetch(request);
      if (response.status === 599) { running = false; exit(Object.assign(new Error('SECRET exit'), { exitCode: 7 })); throw new TypeError('SECRET transport'); }
      // The platform stopped this container (SIGTERM) while no watcher was attached.
      if (response.status === 598) { running = false; throw new TypeError('SECRET the container is not running'); }
      return response;
    } }),
  };
}
