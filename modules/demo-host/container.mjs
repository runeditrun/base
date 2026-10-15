import { DurableObject } from 'cloudflare:workers';
import { claimKeys, signClaim } from './claim.mjs';
import { bounded, boundedFetch, category, report } from './diagnostics.mjs';
import { endedPage, clearCookie } from './pages.mjs';

// One visitor's demo: a Durable Object (newUniqueId) and its container, the
// seed's image from `rer build --platform container` on the workerd engine.
// The container starts with no internet and in demo mode, so withDemo and the
// engine's egress worker refuse every send. The front signs the owner in
// through the existing signed owner claim. The demo ends at its hour or after
// 15 idle minutes: the alarm destroys the container and deletes everything.
const PORT = 8080, IDLE = 15 * 60_000, OWNER = 'owner@demo.invalid';
// The container's port speaks plain HTTP; the app takes its public origin from RER_INGRESS_ORIGIN.
const inside = url => `http://container${url.pathname}${url.search}`;
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export class DemoContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get(['correlation', 'started']);
      this.correlation = state.get('correlation'); this.started = state.get('started');
      if (this.container.running) this.watch();
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
    const row = { event, at: new Date().toISOString(), elapsedMs: Date.now() - this.started, ...detail };
    this.records.push(row); if (this.records.length > 8) this.records.shift();
    report(this.correlation, this.started, event, detail);
  }
  diagnostic() { return { correlation: this.correlation, tail: this.records, stdout: 'Provider container logs; not exposed by the lifecycle API.' }; }
  idle = IDLE;
  startTimeout = 120_000;
  probeTimeout = 5000;
  cleanupRetry = 30_000;
  get container() { return this.ctx.container; }
  port() { return this.container.getTcpPort(PORT); }

  /** Start the container, wait for /health, claim the owner; returns the claim's 303. */
  async start({ origin, originVar, ends, endsLocal, settings, correlation }) {
    this.correlation = correlation; this.started = Date.now(); this.stopped = false;
    const deadline = this.started + this.startTimeout;
    const id = this.ctx.id.toString(), keys = await claimKeys(), now = Date.now();
    await this.ctx.storage.put({ ends, seen: now, correlation, started: this.started });
    await this.ctx.storage.setAlarm(Math.min(ends, now + this.idle));
    report(correlation, this.started, 'start');
    this.container.start({ enableInternet: false, env: { ...settings, RER_DEMO: '1', [originVar]: origin, RER_INGRESS_ORIGIN: origin,
      SESSION_SECRET: random(), SETUP_TOKEN: random(), OWNER_EMAIL: OWNER, RER_OWNER_CLAIM_ISSUER: origin, RER_OWNER_CLAIM_INSTALLATION_ID: id,
      RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(keys.publicKeys), RER_DEMO_EXPIRES: endsLocal } });
    // A container that stops by itself ends the demo too.
    this.watch();
    await this.healthy(deadline);
    const token = await signClaim(keys, { origin, installationId: id, email: OWNER, now: Date.now() });
    const claimed = await boundedFetch(this.port(), 'http://container/auth/owner-claim', { method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, Math.max(1, Math.min(10_000, deadline - Date.now())));
    void claimed.body?.cancel().catch(() => {});
    this.record('claim', { status: claimed.status });
    if (this.stopped) throw new Error('container-stopped');
    if (claimed.status !== 303) throw new Error(`owner claim answered ${claimed.status}`);
    return { location: claimed.headers.get('location'), cookies: claimed.headers.getSetCookie() };
  }

  async healthy(deadline) {
    let attempt = 0;
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('container-stopped');
      const probe = Date.now();
      try {
        const response = await boundedFetch(this.port(), 'http://container/health', {}, Math.min(this.probeTimeout, deadline - Date.now()));
        void response.body?.cancel().catch(() => {});
        this.record('health', { attempt: ++attempt, durationMs: Date.now() - probe, status: response.status });
        if (response.ok && !this.stopped) return;
      } catch (error) {
        this.record('health', { attempt: ++attempt, durationMs: Date.now() - probe, error: category(error) });
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('health-deadline');
  }

  async exited(error) {
    this.stopped = true;
    this.record('exit', { outcome: error ? category(error) : 'exited', ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}) });
    try { await this.end(); } catch (cause) { report(this.correlation, this.started, 'cleanup', { error: category(cause) }); }
  }

  /** Every request carrying this demo's cookie: proxied while the demo lives, else the ended page. */
  async fetch(request) {
    const state = await this.ctx.storage.get(['ends', 'seen']), now = Date.now();
    if (!(state.get('ends') > now)) return endedPage(this.env, { status: 410, headers: { 'set-cookie': clearCookie(this.env) } });
    if (now - state.get('seen') > 60_000) await this.ctx.storage.put('seen', now);
    return this.port().fetch(new Request(inside(new URL(request.url)), request));
  }

  async alarm() {
    const state = await this.ctx.storage.get(['ends', 'seen']), now = Date.now();
    if (await this.ctx.storage.get('stopping')) return this.end();
    if (!state.get('ends')) return;
    if (now >= state.get('ends') || now - state.get('seen') >= this.idle) return this.end();
    await this.ctx.storage.setAlarm(Math.min(state.get('ends'), state.get('seen') + this.idle));
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
    await this.ctx.storage.setAlarm(Date.now() + this.cleanupRetry);
    if (this.container.running) await bounded(this.container.destroy(), 5000);
    await this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')).release(this.ctx.id.toString());
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    report(this.correlation, this.started, 'ended');
  }
}
