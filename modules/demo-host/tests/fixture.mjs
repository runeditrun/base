// The deployed host and real Durable Objects, replacing only the paid Container
// edge. Test-only RPCs advance the clock or discard an object's JS instance.
export { default, DemoCapacity } from '../worker.mjs';
import { DemoContainer as Deployed } from '../container.mjs';
import { platform } from './platform.mjs';

export class DemoContainer extends Deployed {
  instance = crypto.randomUUID();
  incarnation() { return this.instance; }
  cleanupRetry = Number(this.env.TEST_CLEANUP_MS ?? this.cleanupRetry);
  startTimeout = Number(this.env.TEST_START_MS ?? this.startTimeout);
  probeTimeout = Number(this.env.TEST_PROBE_MS ?? this.probeTimeout);
  idle = Number(this.env.TEST_IDLE_MS ?? this.idle);
  get container() { return this.platform ??= platform(this.ctx, this.env.APP); }
  now() { return this.container.now(); }
  events = 0;
  async event(run) {
    if (this.events++ === 0) this.container.active();
    try { return await run(); } finally { if (--this.events === 0) this.container.inactive(); }
  }
  fetch(request) { return this.event(() => super.fetch(request)); }
  alarm() { return this.event(() => super.alarm()); }
  start(options) { return this.event(() => super.start(options)); }
  end() { return this.event(() => super.end()); }
  status() { return this.event(() => super.status()); }
  diagnostic() { return this.event(() => super.diagnostic()); }
  async advance(ms, { restart = false, alarm = false } = {}) {
    this.container.advance(ms);
    await this.ctx.storage.sync();
    if (restart) this.ctx.abort('test object restart');
    if (alarm) await this.alarm();
  }
}
