// Door fixture: genuinely generated visitor keys in refused claims and alarms.
import { DurableObject } from 'cloudflare:workers';
import app from './secret-app.mjs';
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
export class FailureAlarm extends DurableObject {
  async fetch() { await this.ctx.storage.setAlarm(Date.now() + 100); return new Response('armed'); }
  async alarm() { throw new Error(`alarm:${this.env.ENVELOPE_RECORD_KEY}`); }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/auth/owner-claim' && env.FAILURE_MODE === 'claim') {
      return new Response(`sha256=${await digest(env.ENVELOPE_RECORD_KEY)}|${'.'.repeat(385)}${env.ENVELOPE_RECORD_KEY}`, { status: 400 });
    }
    if (path === '/arm') return env.FAILURES.getByName('failure').fetch('https://seed.invalid/arm');
    if (path === '/throw' || path === '/auth/signout' && env.FAILURE_MODE === 'signout') throw new Error(env.ENVELOPE_RECORD_KEY);
    return app.fetch(request, env);
  },
};
