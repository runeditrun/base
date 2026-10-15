import { DurableObject } from 'cloudflare:workers';
import { claimKeys, signClaim } from './claim.mjs';
import { bounded, boundedFetch, category, report } from './diagnostics.mjs';
import { endedPage, clearCookie } from './pages.mjs';
import { finishStart } from './startup.mjs';

// One visitor's demo: a Durable Object (newUniqueId) and its container, the
// seed's image from `rer build --platform container` on the workerd engine.
// The container starts with public internet in demo mode. withDemo simulates
// external effects; the engine also refuses direct mail/SMS transports. The
// front signs the owner in through the existing signed owner claim. The demo ends at its hour or after
// 15 idle minutes: the alarm destroys the container and deletes everything.
// Container lifetime is independent of the object's JS lifetime. Configure the
// platform's inactivity grace on every object instance; persisted alarms and
// request-time checks enforce the visitor's exact idle and absolute deadlines.
const PORT = 8080, IDLE = 15 * 60_000, OWNER = 'owner@demo.invalid';
// The container's port speaks plain HTTP; the app takes its public origin from RER_INGRESS_ORIGIN.
const inside = url => `http://container${url.pathname}${url.search}`;
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export class DemoContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get(['correlation', 'started', 'startup']);
      this.correlation = state.get('correlation'); this.started = state.get('started');
      if (state.get('startup')?.phase === 'starting') {
        // An interrupted start has lost its private claim key and cannot be
        // resumed after object eviction. End it instead of polling forever.
        await ctx.storage.put('startup', { phase: 'failed' });
        ctx.waitUntil(this.end().catch(cause => report(this.correlation, this.started, 'cleanup', { error: category(cause) })));
      } else if (this.container.running) {
        await this.container.setInactivityTimeout(this.idle);
        this.watch();
      }
    });
  }
  watch() {
    if (!this.watching) {
      this.watching = true;
      this.ctx.waitUntil(this.container.monitor().then(() => this.exited(), error => this.exited(error)));
    }
  }
  records = [];
  record(event, detail = {}) {
    const row = { event, at: new Date().toISOString(), elapsedMs: this.now() - this.started, ...detail };
    this.records.push(row); if (this.records.length > 8) this.records.shift();
    report(this.correlation, this.started, event, detail);
  }
  diagnostic() { return { correlation: this.correlation, tail: this.records, stdout: 'Provider container logs; not exposed by the lifecycle API.' }; }
  idle = IDLE;
  startTimeout = 45_000;
  probeTimeout = 5000;
  cleanupRetry = 30_000;
  now() { return Date.now(); }
  get container() { return this.ctx.container; }
  port() { return this.container.getTcpPort(PORT); }

  async begin(options) {
    if (!await this.ctx.storage.get('startup')) {
      await this.ctx.storage.put('startup', { phase: 'starting' });
      this.ctx.waitUntil(finishStart(this, options));
    }
    return this.status();
  }

  async status() {
    const startup = await this.ctx.storage.get('startup');
    return { ...(startup ?? { phase: 'failed' }), correlation: this.correlation };
  }

  /** Start the container, wait for /health, claim the owner; returns the claim's 303. */
  async start({ origin, originVar, ends, endsLocal, settings, correlation }) {
    this.correlation = correlation; this.started = this.now(); this.stopped = false;
    const deadline = this.started + this.startTimeout;
    const id = this.ctx.id.toString(), keys = await claimKeys(), now = this.now();
    await this.ctx.storage.put({ ends, seen: now, correlation, started: this.started, startDeadline: deadline });
    report(correlation, this.started, 'start');
    if (this.stopped) throw new Error('container-stopped');
    this.container.start({ enableInternet: true, env: { ...settings, RER_DEMO: '1', [originVar]: origin, RER_INGRESS_ORIGIN: origin, RER_INGRESS_ORIGINS: JSON.stringify([origin, ...JSON.parse(this.env.DEMO_SECONDARY_ORIGINS ?? '[]')]),
      SESSION_SECRET: random(), SETUP_TOKEN: random(), OWNER_EMAIL: OWNER, RER_OWNER_CLAIM_ISSUER: origin, RER_OWNER_CLAIM_INSTALLATION_ID: id,
      RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(keys.publicKeys), RER_DEMO_EXPIRES: endsLocal } });
    await this.container.setInactivityTimeout(this.idle);
    // A container that stops by itself ends the demo too.
    this.watch();
    await this.ctx.storage.setAlarm(deadline);
    await this.healthy(deadline);
    const token = await signClaim(keys, { origin, installationId: id, email: OWNER, now: this.now() });
    const claimed = await boundedFetch(this.port(), 'http://container/auth/owner-claim', { method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, Math.max(1, Math.min(10_000, deadline - this.now())));
    void claimed.body?.cancel().catch(() => {});
    this.record('claim', { status: claimed.status });
    if (this.stopped) throw new Error('container-stopped');
    if (claimed.status !== 303) throw new Error(`owner claim answered ${claimed.status}`);
    await this.ctx.storage.put('seen', this.now());
    await this.ctx.storage.setAlarm(Math.min(ends, this.now() + this.idle));
    return { location: claimed.headers.get('location'), cookies: claimed.headers.getSetCookie() };
  }

  async healthy(deadline) {
    let attempt = 0;
    while (this.now() < deadline) {
      if (this.stopped) throw new Error('container-stopped');
      const probe = this.now();
      try {
        const response = await boundedFetch(this.port(), 'http://container/health', {}, Math.min(this.probeTimeout, deadline - this.now()));
        void response.body?.cancel().catch(() => {});
        this.record('health', { attempt: ++attempt, durationMs: this.now() - probe, status: response.status });
        if (response.ok && !this.stopped) return;
      } catch (error) {
        this.record('health', { attempt: ++attempt, durationMs: this.now() - probe, error: category(error) });
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - this.now()))));
    }
    throw new Error('health-deadline');
  }

  async exited(error) {
    this.stopped = true;
    this.record('exit', { outcome: error ? category(error) : 'exited', ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}) });
    if ((await this.ctx.storage.get('startup'))?.phase === 'starting') return;
    try { await this.end(); } catch (cause) { report(this.correlation, this.started, 'cleanup', { error: category(cause) }); }
  }

  /** Every request carrying this demo's cookie: proxied while the demo lives, else the ended page. */
  async fetch(request) {
    const state = await this.ctx.storage.get(['ends', 'seen']), now = this.now();
    if (!state.get('ends') || now >= Math.min(state.get('ends'), state.get('seen') + this.idle)) {
      try { await this.end(); }
      catch (cause) { report(this.correlation, this.started, 'cleanup', { error: category(cause) }); }
      return this.ended();
    }
    if (!this.container.running) return this.gone();
    await this.ctx.storage.put('seen', now);
    await this.ctx.storage.setAlarm(Math.min(state.get('ends'), now + this.idle));
    const forwarded = new Request(inside(new URL(request.url)), request);
    // The front admits only declared hosts. Never let a visitor choose the
    // container's public origin through a transport header.
    forwarded.headers.set('x-rer-ingress-origin', new URL(request.url).origin);
    try { return await this.port().fetch(forwarded); }
    catch (error) { if (this.container.running && !this.stopped) throw error; return this.gone(); }
  }

  ended() { return endedPage(this.env, { status: 410, headers: { 'set-cookie': clearCookie(this.env) } }); }

  /** A container the platform stopped while nothing watched it: end the demo (the alarm retries a failed cleanup). */
  async gone() {
    this.record('exit', { outcome: 'gone' });
    try { await this.end(); } catch (cause) { report(this.correlation, this.started, 'cleanup', { error: category(cause) }); }
    return this.ended();
  }

  async alarm() {
    const state = await this.ctx.storage.get(['ends', 'seen', 'startDeadline']), now = this.now();
    if (await this.ctx.storage.get('stopping')) return this.end();
    if (!state.get('ends')) return;
    const due = Math.min(state.get('ends'), state.get('seen') + this.idle, state.get('startDeadline') ?? Infinity);
    if (now >= due || !this.container.running) {
      if ((await this.ctx.storage.get('startup'))?.phase === 'starting') { this.stopped = true; return; }
      return this.end();
    }
    await this.ctx.storage.setAlarm(due);
  }

  /** Destroy the container and delete this demo's state and place; safe to repeat. */
  async end() {
    if (this.ending) return this.ending;
    this.ending = this.cleanup();
    try { await this.ending; } finally { this.ending = null; }
  }

  async cleanup() {
    this.stopped = true;
    // Keep the alarm and capacity reservation if destruction fails; retry cleanup.
    await this.ctx.storage.put('stopping', true);
    await this.ctx.storage.setAlarm(this.now() + this.cleanupRetry);
    if (this.container.running) {
      try { await bounded(this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')).extend(this.ctx.id.toString(), this.now() + 60_000), 2000); }
      catch (cause) { report(this.correlation, this.started, 'cleanup-reservation', { error: category(cause) }); }
      await bounded(this.container.destroy(), 5000);
    }
    await bounded(this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')).release(this.ctx.id.toString()), 2000);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    report(this.correlation, this.started, 'ended');
  }
}
