import { DurableObject } from 'cloudflare:workers';
import { claimKeys, signClaim } from './claim.mjs';
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
  idle = IDLE;
  get container() { return this.ctx.container; }
  port() { return this.container.getTcpPort(PORT); }

  /** Start the container, wait for /health, claim the owner; returns the claim's 303. */
  async start({ origin, originVar, ends, endsLocal, settings }) {
    const id = this.ctx.id.toString(), keys = await claimKeys(), now = Date.now();
    await this.ctx.storage.put({ ends, seen: now });
    await this.ctx.storage.setAlarm(Math.min(ends, now + this.idle));
    this.container.start({ enableInternet: false, env: { ...settings, RER_DEMO: '1', [originVar]: origin, RER_INGRESS_ORIGIN: origin,
      SESSION_SECRET: random(), SETUP_TOKEN: random(), OWNER_EMAIL: OWNER, RER_OWNER_CLAIM_ISSUER: origin, RER_OWNER_CLAIM_INSTALLATION_ID: id,
      RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(keys.publicKeys), RER_DEMO_EXPIRES: endsLocal } });
    // A container that stops by itself ends the demo too.
    this.container.monitor().then(() => this.end(), () => this.end());
    await this.healthy();
    const token = await signClaim(keys, { origin, installationId: id, email: OWNER, now: Date.now() });
    const claimed = await this.port().fetch('http://container/auth/owner-claim', { method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    await claimed.body?.cancel();
    if (claimed.status !== 303) throw new Error(`owner claim answered ${claimed.status}`);
    return { location: claimed.headers.get('location'), cookies: claimed.headers.getSetCookie() };
  }

  async healthy() {
    for (const deadline = Date.now() + 120_000; ;) {
      try {
        const response = await this.port().fetch('http://container/health');
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* The container is still starting. */ }
      if (Date.now() > deadline) throw new Error('demo container never became healthy');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
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
    if (!state.get('ends')) return;
    if (now >= state.get('ends') || now - state.get('seen') >= this.idle) return this.end();
    await this.ctx.storage.setAlarm(Math.min(state.get('ends'), state.get('seen') + this.idle));
  }

  /** Destroy the container and delete this demo's state and place; safe to repeat. */
  async end() {
    if (this.container.running) await this.container.destroy().catch(() => { /* Already stopping. */ });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')).release(this.ctx.id.toString());
  }
}
