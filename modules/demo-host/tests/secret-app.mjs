// A small encrypted-record seed for the hosted start door. The same dedicated
// AES key contract as Envelope; only fingerprints ever leave the runtime.
import { verifyOwnerClaim } from '../../owner-claim/verify.mjs';
const encoder = new TextEncoder();
const fingerprint = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function recordKey(value) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Object.assign(new Error('payroll_record_key_required'), { status: 503 });
  return crypto.subtle.importKey('raw', Uint8Array.from(atob(value), c => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export default {
  async fetch(request, env) {
    try {
      const key = await recordKey(env.ENVELOPE_RECORD_KEY);
      const path = new URL(request.url).pathname;
      if (path === '/auth/owner-claim') {
        await verifyOwnerClaim(new URLSearchParams(await request.text()).get('token'), { issuer: env.RER_OWNER_CLAIM_ISSUER,
          installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID, appOrigin: env.AUTH_ORIGIN,
          expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) });
        return new Response(null, { status: 303, headers: { location: '/company' } });
      }
      if (path === '/health') {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode('Harbor Print Studio · October payroll · 6 people'));
        await env.DB.prepare('INSERT OR IGNORE INTO company VALUES(1,?,?)').bind(btoa(String.fromCharCode(...iv)), btoa(String.fromCharCode(...new Uint8Array(data)))).run();
        return new Response('ready');
      }
      if (path === '/key-info') return Response.json({ length: env.ENVELOPE_RECORD_KEY.length, bytes: atob(env.ENVELOPE_RECORD_KEY).length,
        digest: await fingerprint(env.ENVELOPE_RECORD_KEY), other: await fingerprint(env.RECORD_AUDIT_KEY), otherLength: env.RECORD_AUDIT_KEY.length,
        undeclared: env.UNDECLARED_KEY === undefined });
      const row = await env.DB.prepare('SELECT iv,data FROM company WHERE id=1').first();
      if (path === '/export') return Response.json({ company: row }, { headers: { 'content-disposition': 'attachment; filename=company.json' } });
      const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(row.iv), c => c.charCodeAt(0)) }, key, Uint8Array.from(atob(row.data), c => c.charCodeAt(0)));
      return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor Print Studio Demo</title><main><h1>Harbor Print Studio</h1><p>${new TextDecoder().decode(data)}</p><a href="/export">Export encrypted company</a></main>`, { headers: { 'content-type': 'text/html' } });
    } catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 500 }); }
  },
};
