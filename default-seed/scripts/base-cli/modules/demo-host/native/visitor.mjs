import { DurableObject } from 'cloudflare:workers';
import { claimKeys, signClaim } from '../claim.mjs';
import { migrate } from '../../container/migrations.mjs';
import { DemoD1 } from './d1.mjs';
import { application, bundle } from './loader.mjs';
import { database, object, r2, eraseResources } from './resources.mjs';
import { enqueue, deliverQueues, nextQueue, queueMetrics } from './queues.mjs';
import { seedAlarm, nextSeedAlarm, deliverSeedAlarms } from './alarms.mjs';
import { cronMatches } from './cron.mjs';
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
      RER_NATIVE_KEY: random(), SESSION_SECRET: random(), SETUP_TOKEN: random(), OWNER_EMAIL: this.env.DEMO_OWNER_EMAIL || 'owner@demo.invalid',
      RER_OWNER_CLAIM_ISSUER: origin, RER_OWNER_CLAIM_INSTALLATION_ID: id,
      RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(keys.publicKeys), RER_DEMO_EXPIRES: endsLocal };
    this.state = { phase: 'starting', runtime, ends, seen: started, savedSeen: started, lastCron: Math.floor(started / 60_000), correlation };
    await this.save();
    await this.ctx.storage.setAlarm(Math.min(ends, started + IDLE));
    try {
      const at = Date.now();
      const app = application(this.env, this.ctx, id, runtime);
      for (const binding of bundle.bindings.databases) {
        const sql = { query: (...args) => this.database(binding, 'query', args), batch: (...args) => this.database(binding, 'batch', args), exec: (...args) => this.database(binding, 'exec', args) };
        await migrate(new DemoD1(sql), bundle.migrations[binding] ?? []);
      }
      const migrated = Date.now();
      const token = await signClaim(keys, { origin, installationId: id, email: runtime.OWNER_EMAIL, now: Date.now() });
      const claimed = await app.fetch(new Request(origin + '/auth/owner-claim', { method: 'POST', redirect: 'manual', headers: { origin, 'cf-connecting-ip': clientIp, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }));
      if (claimed.status !== 303) throw new Error(`owner-claim-${claimed.status}: ${(await claimed.text()).slice(0, 500)}`);
      await claimed.body?.cancel();
      const cookies = claimed.headers.getSetCookie();
      const seeded = await app.fetch(new Request(origin + '/health', { headers: { 'cf-connecting-ip': clientIp, cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') } }));
      await seeded.arrayBuffer();
      if (!seeded.ok) throw new Error(`demo-seed-${seeded.status}`);
      if (!await this.capacity().extend(id, ends)) throw new Error('start-reservation-expired');
      // Checked after the extend, right before ready: an end that ran meanwhile
      // released this place, and the copy must not outlive it.
      if (this.state?.phase !== 'starting') throw new Error('demo-ended-during-start');
      this.state = { ...this.state, phase: 'ready', cookies, location: claimed.headers.get('location'), timing: { migrationsMs: migrated - at, claimAndSeedMs: Date.now() - migrated, totalMs: Date.now() - started } };
      await this.save();
      await this.schedule(await nextQueue(this));
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
    if (this.state?.phase === 'ending') throw new Error('demo-ended');
    if (!this.state || this.state.ends <= Date.now() || this.state.seen + IDLE <= Date.now()) {
      if (this.state) await this.end();
      throw new Error('demo-ended');
    }
  }
  async session() {
    try { await this.active(); } catch { return null; }
    if (this.state.phase !== 'ready') return null;
    this.state.seen = Date.now();
    if (this.state.seen - this.state.savedSeen >= 60_000) {
      this.state.savedSeen = this.state.seen;
      await this.save();
    }
    return this.state.runtime;
  }
  status() { return this.state && this.state.phase !== 'ending' ? { phase: this.state.phase, cookies: this.state.cookies ?? [], location: this.state.location, correlation: this.state.correlation, timing: this.state.timing } : { phase: 'failed' }; }
  async fetch(request) {
    if (this.state && request.headers.get('x-rer-native-key') === this.state.runtime.RER_NATIVE_KEY) {
      const [binding, id] = (request.headers.get('x-rer-native-object') ?? '').split(':');
      const headers = new Headers(request.headers);
      headers.delete('x-rer-native-key'); headers.delete('x-rer-native-object');
      return this.object(binding, id, 'fetch', [new Request(request, { headers })]);
    }
    const runtime = await this.session();
    if (!runtime) return endedPage({ ...this.env, DEMO_THEME: bundle.theme, DEMO_ICON_HEAD: bundle.iconHead }, { headers: { 'set-cookie': clearCookie(this.env) } });
    return application(this.env, this.ctx, this.ctx.id.toString(), runtime).fetch(request);
  }
  // The seed signs the visitor out, then the copy ends as an expired one does.
  // A form navigation gets the ended page; a script gets the seed's answer and
  // its next page load finds the ended page.
  async signOut(request) {
    const runtime = await this.session();
    if (!runtime) return endedPage({ ...this.env, DEMO_THEME: bundle.theme, DEMO_ICON_HEAD: bundle.iconHead }, { headers: { 'set-cookie': clearCookie(this.env) } });
    const response = await application(this.env, this.ctx, this.ctx.id.toString(), runtime).fetch(request);
    if (response.status >= 400) return response;
    const body = await response.arrayBuffer();
    await this.end();
    if (/text\/html/.test(request.headers.get('accept') ?? '')) return endedPage({ ...this.env, DEMO_THEME: bundle.theme, DEMO_ICON_HEAD: bundle.iconHead }, { headers: { 'set-cookie': clearCookie(this.env) } });
    return new Response(response.status === 204 ? null : body, response);
  }
  database(binding, method, args) { return database(this, binding, method, args); }
  object(binding, id, method, args) { return object(this, binding, id, method, args); }
  r2(binding, method, args) { return r2(this, binding, method, args); }
  queueMetrics(queue) { return queueMetrics(this, queue); }
  enqueue(queue, messages) { return enqueue(this, queue, messages); }
  seedAlarm(binding, id, method, at) { return seedAlarm(this, binding, id, method, at); }
  async schedule(candidate = Infinity) {
    if (!this.state || this.state.phase === 'ending') return;
    const at = Math.max(Date.now() + 50, Math.min(candidate, await nextSeedAlarm(this), this.state.ends, this.state.seen + IDLE, (Math.floor(Date.now() / 60_000) + 1) * 60_000));
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > at) await this.ctx.storage.setAlarm(at);
  }
  async alarm() {
    // An ending copy's alarm finishes its erasure; a failed attempt keeps the retry alarm.
    if (this.state?.phase === 'ending') { await this.end(); return this.erasing; }
    try { await this.active(); } catch { return this.erasing; }
    try {
      if (this.state.phase === 'ready') {
        const now = Date.now(), minute = Math.floor(now / 60_000);
        if (minute > this.state.lastCron) {
          this.state.lastCron = minute;
          await this.save();
          for (const cron of bundle.crons) if (cronMatches(cron, new Date(now))) {
            await application(this.env, this.ctx, this.ctx.id.toString(), this.state.runtime).runScheduled(minute * 60_000, cron);
            console.log(JSON.stringify({ event: 'native-demo-scheduled', correlation: this.state?.correlation, cron }));
          }
        }
        await deliverSeedAlarms(this, now);
        await deliverQueues(this, now);
      }
    } finally { await this.schedule(await nextQueue(this)); }
  }
  // Cancel, sign-out, expiry and a failed start all end here. The copy stops
  // serving and frees its place first, so the next visitor is admitted at once
  // however long erasing its storage takes (an upload still streaming into R2
  // holds that). Concurrent ends share one release; a later one finds the copy
  // already erasing. Erasure follows, and the retry alarm repeats it until done.
  end() {
    if (this.erasing) return Promise.resolve();
    this.ending ??= this.retire().finally(() => { this.ending = undefined; });
    return this.ending;
  }
  async retire() {
    if (this.state) { this.state.phase = 'ending'; await this.save(); }
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
    await this.capacity().release(this.ctx.id.toString());
    this.erasing = this.erase()
      .catch(error => console.error(JSON.stringify({ event: 'native-demo-erase-failed', message: error.message })))
      .finally(() => { this.erasing = undefined; });
  }
  async erase() {
    await eraseResources(this);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.state = undefined;
  }
}
