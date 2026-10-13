// Demo mode: one guard a seed imports first in its Worker entry. It does nothing
// unless the runtime has RER_DEMO=1 (`rer demo`, or a hosted demo container).
// With it, nothing leaves the machine: global fetch answers loopback only for the
// whole isolate (routes, cron, queue consumers, Durable Objects), and every
// refused call is recorded by method and host. The seed's seedDemo hook runs once
// after the owner exists, and every HTML page carries a "Demo" bar listing the
// captured mail and the blocked sends.
import { env } from 'cloudflare:workers';
import { escapeHtml, isLoopbackHost } from '../operator-auth/http.mjs';
import { allow, sha256 } from '../operator-auth/csp.mjs';

const on = env?.RER_DEMO === '1';
let database = 'DB';
const db = () => env[database];

// Evaluated before the rest of the entry's imports, so no module can keep the
// real fetch. A refused call throws the network error fetch itself throws, which
// seeds already treat as a failed delivery.
if (on) {
  const send = globalThis.fetch;
  globalThis.fetch = async function demoFetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (isLoopbackHost(url.hostname)) return send(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      await ready();
      await db().prepare('INSERT INTO rer_demo_outbound(at, method, host) VALUES (?, ?, ?)').bind(Date.now(), method, url.host).run();
    } catch { /* The refusal stands even when it cannot be recorded. */ }
    throw new TypeError(`fetch failed: demo mode sends nothing (${method} ${url.host} refused)`);
  };
}

let tables;
function ready() {
  return tables ??= db().batch([
    db().prepare('CREATE TABLE IF NOT EXISTS rer_demo (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)'),
    db().prepare('CREATE TABLE IF NOT EXISTS rer_demo_outbound (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, method TEXT NOT NULL, host TEXT NOT NULL)'),
  ]).catch(error => { tables = undefined; throw error; });
}

// Base operator-auth's owner; a seed with its own accounts passes `owner`.
async function operatorOwner(bindings) {
  const row = await bindings[database].prepare("SELECT email FROM oa_operators WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1").first();
  return row?.email ?? null;
}

let seeded = false, seeding;
async function seedOnce(bindings, seed, owner) {
  if (seeded) return;
  await ready();
  if (!seed) { seeded = true; return; }
  if (await db().prepare("SELECT 1 FROM rer_demo WHERE name = 'seeded'").first()) { seeded = true; return; }
  const ownerEmail = await owner(bindings);
  if (!ownerEmail) return;
  const now = new Date();
  await seed(bindings, { ownerEmail, now });
  await db().prepare("INSERT OR IGNORE INTO rer_demo(name, value) VALUES ('seeded', ?)").bind(now.toISOString()).run();
  seeded = true;
}

const STYLE = 'body:has(>#rer-demo-bar){grid-template-rows:auto 1fr}#rer-demo-bar{grid-column:1/-1;justify-self:stretch;align-self:start;position:relative;z-index:2147483646;box-sizing:border-box;width:100%;margin:0 0 12px;padding:6px 12px;border-radius:8px;background:#7c2d12;color:#fff7ed;font:13px/1.5 system-ui,sans-serif;text-align:left}#rer-demo-bar summary{min-height:24px;cursor:pointer;overflow-wrap:anywhere;font-weight:600}#rer-demo-bar summary:focus-visible{outline:2px solid #fff;outline-offset:2px}#rer-demo-bar h2{margin:8px 0 2px;font:inherit;font-weight:600}#rer-demo-bar ul{margin:0;padding:0 0 0 18px}#rer-demo-bar p{margin:0;opacity:.85}';
let styleHash;

// The end time as the starter wrote it (local ISO with offset): show its HH:MM.
const ends = value => /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(value ?? '')?.[1];

async function barHtml() {
  const rows = (sql, fallback = []) => db().prepare(sql).all().then(result => result.results).catch(() => fallback);
  const [mail, mailCount, blocked, blockedCount] = await Promise.all([
    rows('SELECT message FROM rer_mail_development_outbox ORDER BY created_at DESC, sequence DESC LIMIT 5').then(list => list.map(row => JSON.parse(row.message))),
    rows('SELECT COUNT(*) AS count FROM rer_mail_development_outbox', [{ count: 0 }]),
    rows('SELECT method, host, COUNT(*) AS times FROM rer_demo_outbound GROUP BY method, host ORDER BY MAX(sequence) DESC LIMIT 5'),
    rows('SELECT COUNT(*) AS count FROM rer_demo_outbound', [{ count: 0 }]),
  ]);
  const until = ends(env.RER_DEMO_EXPIRES);
  const summary = ['Demo', 'nothing is sent', ...(until ? [`ends ${until}`] : []), `${mailCount[0].count} mail captured`, `${blockedCount[0].count} ${blockedCount[0].count === 1 ? 'send' : 'sends'} blocked`].join(' · ');
  const recipients = to => (Array.isArray(to) ? to : [to]).map(item => typeof item === 'string' ? item : item?.email).filter(Boolean).join(', ');
  const mailList = mail.length ? `<ul>${mail.map(message => `<li>${escapeHtml(message.subject ?? '(no subject)')} → ${escapeHtml(recipients(message.to))}</li>`).join('')}</ul>` : '<p>None yet.</p>';
  const blockedList = blocked.length ? `<ul>${blocked.map(row => `<li>${escapeHtml(row.method)} ${escapeHtml(row.host)}${row.times > 1 ? ` (${row.times}×)` : ''}</li>`).join('')}</ul>` : '<p>None yet.</p>';
  return `<style>${STYLE}</style><aside id="rer-demo-bar" aria-label="Demo"><details><summary>${escapeHtml(summary)}</summary><h2>Captured mail (in the outbox, not sent)</h2>${mailList}<h2>Blocked sends</h2>${blockedList}</details></aside>`;
}

async function decorate(response) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/html') || !response.body) return response;
  const headers = new Headers(response.headers);
  const policy = headers.get('content-security-policy');
  if (policy) headers.set('content-security-policy', allow(policy, 'style-src', styleHash ??= await sha256(STYLE)));
  headers.delete('content-length');
  const [html, bar] = await Promise.all([response.text(), barHtml()]);
  const open = /<body\b[^>]*>/i.exec(html), at = open ? open.index + open[0].length : 0;
  return new Response(html.slice(0, at) + bar + html.slice(at), { status: response.status, statusText: response.statusText, headers });
}

/**
 * Wraps a seed's Worker for demo mode; without RER_DEMO=1 it returns the worker
 * unchanged. `seed(env, { ownerEmail, now })` is the seed's idempotent demo data.
 */
export function withDemo(worker, { seed, binding = 'DB', owner = operatorOwner } = {}) {
  if (!on) return worker;
  database = binding;
  const prepared = bindings => seeding ??= seedOnce(bindings, seed, owner).finally(() => { seeding = undefined; });
  return {
    ...worker,
    async fetch(request, bindings, execution) {
      await prepared(bindings);
      return decorate(await worker.fetch(request, bindings, execution));
    },
    ...(worker.scheduled ? { async scheduled(controller, bindings, execution) { await prepared(bindings); return worker.scheduled(controller, bindings, execution); } } : {}),
    ...(worker.queue ? { async queue(batch, bindings, execution) { await prepared(bindings); return worker.queue(batch, bindings, execution); } } : {}),
  };
}
