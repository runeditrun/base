import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { devGate, DEV_KEY_PATH } from '../modules/operator-auth/dev-gate.mjs';
import { OWNER_SIGNIN_SECONDS, OWNER_SIGNIN_PATH, ownerSigninDigest } from '../modules/operator-auth/owner-signin-grant.mjs';
import { loopback } from './parse.mjs';
import { openUrl } from './dev-identity.mjs';
import { shared } from './shared.mjs';

// The dev fragment exchange, with a run-owned, expiring, single-use key. Only
// an independent native grant digest enters the local ledger, on redemption.
// The public key cannot redeem that grant outside this proxy's lifetime. Neither
// credential is saved; the native grant supplies normal owner fencing.
export function nativeOwnerEntry({ origin, state, store, demo, devKey, clock = Date.now }) {
 if (!loopback(new URL(origin).hostname)) return null;
 let entry, grant;
 const same = (a, b) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
 function issue() {
  const key = randomBytes(32).toString('base64url');
  store.addSecrets([key]);
  entry = { key, expires: clock() + OWNER_SIGNIN_SECONDS * 1000, used: false, gate: devGate({ key, origin, local: true }) };
  return openUrl(origin, key, { path: DEV_KEY_PATH, next: '/' });
 }
 async function database() {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(state, 'v3/d1/miniflare-D1DatabaseObject'), found = [];
  for (const file of await readdir(directory)) {
   if (!file.endsWith('.sqlite')) continue;
   const path = join(directory, file), db = new DatabaseSync(path, { readOnly: true });
   try { if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='oa_owner_signins' AND type='table'").get()) found.push(path); }
   finally { db.close(); }
  }
  if (found.length !== 1) throw Error('Local native owner entry requires exactly one owner sign-in ledger.');
  return new DatabaseSync(found[0]);
 }
 async function clear() {
  if (!grant) return;
  const db = await database();
  try { db.prepare('DELETE FROM oa_owner_signins WHERE id=?').run(grant); grant = undefined; }
  finally { db.close(); }
 }
 return {
  issue,
  async close() { entry = undefined; await clear(); },
  async handle(req, res) {
   if (req.url !== DEV_KEY_PATH) return false;
   const reply = async response => {
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return true;
   };
   const denied = () => new Response('This owner link is unavailable. Run the command again for a fresh link.', { status: 403, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'referrer-policy': 'no-referrer' } });
   if (req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== origin) return reply(denied());
   if (req.method === 'GET' || req.method === 'HEAD') {
    if (demo) return false;
    return reply(await entry.gate.exchange(new Request(origin + DEV_KEY_PATH, { method: req.method })));
   }
   if (req.method !== 'POST') return demo ? false : reply(denied());
   let body = '';
   for await (const bytes of req) { body += bytes; if (body.length > 1024) return reply(denied()); }
   let key; try { key = JSON.parse(body).key; } catch {}
   // Preserve the demo persona through the same dev gate as its Worker.
   if (demo && entry && typeof key === 'string' && !same(key, entry.key)) return reply(await devGate({ key: devKey, origin, local: true }).exchange(new Request(origin + DEV_KEY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body })));
   if (!entry || typeof key !== 'string' || !same(key, entry.key) || entry.used || clock() >= entry.expires || req.headers.origin !== origin) return reply(denied());
   entry.used = true;
   const exchange = await entry.gate.exchange(new Request(origin + DEV_KEY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
   if (!exchange.ok) return reply(denied());
   await clear();
   const id = randomUUID(), nativeToken = randomBytes(32).toString('base64url');
   store.addSecrets([nativeToken]);
   const db = await database(), now = clock();
   try {
    db.prepare(`INSERT INTO oa_owner_signins(id,token_hash,operator_id,operator_version,created_at,expires_at)
      SELECT ?,?,o.id,o.version,?,? FROM oa_operators o LEFT JOIN oa_bootstrap b ON b.claim_id=o.id
      WHERE o.role='owner' AND o.status='active' ORDER BY b.claim_id IS NULL,o.created_at,o.id LIMIT 1`).run(id, await ownerSigninDigest(nativeToken), now, entry.expires);
    grant = id;
   } finally { db.close(); }
   const { appFetch } = await shared('app-fetch.mjs');
   const response = await appFetch(origin + OWNER_SIGNIN_PATH, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: nativeToken }), signal: AbortSignal.timeout(10000) });
   if (response.status !== 303) { await response.body?.cancel(); return reply(denied()); }
   const cookies = response.headers.getSetCookie(); await response.body?.cancel();
   res.writeHead(204, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookies }); res.end();
   return true;
  },
 };
}
