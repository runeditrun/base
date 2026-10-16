import { DurableObject } from 'cloudflare:workers';
import { claimKeys, signClaim } from '../claim.mjs';
import { migrate } from '../../deploy-kit/local-migrations.mjs';
import { DemoD1 } from './d1.mjs';
import { application, bundle } from './loader.mjs';
import { endedPage, clearCookie } from '../pages.mjs';

const IDLE = 15 * 60_000;
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export class NativeDemo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.state = await ctx.storage.get('visitor'); });
  }
  async save() { await this.ctx.storage.put('visitor', this.state); }
  async begin(options) {
    try { return await this.start(options); }
    catch (error) {
      await this.diagnostic(options.correlation, error);
      await this.end();
      return { phase: 'failed', correlation: options.correlation };
    }
  }
  async diagnostic(correlation, error) {
    await this.env.CAPACITY.get(this.env.CAPACITY.idFromName('diagnostics')).record(correlation, { failure: String(error.message).slice(0, 1000) });
  }
  async start({ origin, originVar, ends, endsLocal, settings, correlation, clientIp }) {
    if (this.state) return this.status();
    const id = this.ctx.id.toString(), keys = await claimKeys(), started = Date.now();
    // Short TTLs are usable only on the guarded testing host.
    if (/^[123]x0{31}AA$/.test(this.env.TURNSTILE_SECRET_KEY ?? '') && this.env.NATIVE_TEST_TTL_MS) ends = Math.min(ends, started + Number(this.env.NATIVE_TEST_TTL_MS));
    const runtime = { ...bundle.vars, ...settings, RER_DEMO: '1', [originVar]: origin,
      SESSION_SECRET: random(), SETUP_TOKEN: random(), OWNER_EMAIL: this.env.DEMO_OWNER_EMAIL || 'owner@demo.invalid',
      RER_OWNER_CLAIM_ISSUER: origin, RER_OWNER_CLAIM_INSTALLATION_ID: id,
      RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(keys.publicKeys), RER_DEMO_EXPIRES: endsLocal };
    this.state = { phase: 'starting', runtime, ends, seen: started, correlation };
    await this.save();
    await this.ctx.storage.setAlarm(Math.min(ends, started + IDLE));
    try {
      const at = Date.now();
      const app = application(this.env, this.ctx, id, runtime);
      await migrate(new DemoD1(app), bundle.migrations);
      const migrated = Date.now();
      const token = await signClaim(keys, { origin, installationId: id, email: runtime.OWNER_EMAIL, now: Date.now() });
      const claimed = await app.fetch(new Request(origin + '/auth/owner-claim', { method: 'POST', redirect: 'manual', headers: { origin, 'cf-connecting-ip': clientIp, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }));
      if (claimed.status !== 303) throw new Error(`owner-claim-${claimed.status}: ${(await claimed.text()).slice(0, 500)}`);
      await claimed.body?.cancel();
      const cookies = claimed.headers.getSetCookie();
      const seeded = await app.fetch(new Request(origin + '/health', { headers: { cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') } }));
      await seeded.arrayBuffer();
      if (!seeded.ok) throw new Error(`demo-seed-${seeded.status}`);
      if (!await this.capacity().extend(id, ends)) throw new Error('start-reservation-expired');
      this.state = { ...this.state, phase: 'ready', cookies, location: claimed.headers.get('location'), timing: { migrationsMs: migrated - at, claimAndSeedMs: Date.now() - migrated, totalMs: Date.now() - started } };
      await this.save();
      await this.ctx.storage.setAlarm(Math.min(ends, Date.now() + 60_000));
      return this.status();
    } catch (error) {
      console.error(JSON.stringify({ event: 'native-demo-start-failed', correlation, message: error.message }));
      await this.diagnostic(correlation, error);
      await this.end();
      return { phase: 'failed', correlation };
    }
  }
  capacity() { return this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')); }
  async active() {
    if (!this.state || this.state.ends <= Date.now() || this.state.seen + IDLE <= Date.now()) {
      if (this.state) await this.end();
      throw new Error('demo-ended');
    }
  }
  async session() {
    try { await this.active(); } catch { return null; }
    if (this.state.phase !== 'ready') return null;
    this.state.seen = Date.now();
    await this.save();
    return this.state.runtime;
  }
  status() { return this.state ? { phase: this.state.phase, cookies: this.state.cookies ?? [], location: this.state.location, correlation: this.state.correlation, timing: this.state.timing } : { phase: 'failed' }; }
  async fetch(request) {
    const runtime = await this.session();
    if (!runtime) return endedPage(this.env, { headers: { 'set-cookie': clearCookie(this.env) } });
    return application(this.env, this.ctx, this.ctx.id.toString(), runtime).fetch(request);
  }
  async alarm() {
    try { await this.active(); } catch { return; }
    try {
      if (this.state.phase === 'ready') for (const cron of bundle.crons) {
        await application(this.env, this.ctx, this.ctx.id.toString(), this.state.runtime).runScheduled(Date.now(), cron);
        console.log(JSON.stringify({ event: 'native-demo-scheduled', correlation: this.state.correlation, at: new Date().toISOString() }));
      }
    } finally {
      if (this.state) await this.ctx.storage.setAlarm(Math.min(this.state.ends, this.state.seen + IDLE, Date.now() + 60_000));
    }
  }
  async end() {
    await this.ctx.storage.deleteAlarm();
    this.ctx.facets.delete('app');
    await this.ctx.storage.deleteAll();
    this.state = undefined;
    await this.capacity().release(this.ctx.id.toString());
  }
}
