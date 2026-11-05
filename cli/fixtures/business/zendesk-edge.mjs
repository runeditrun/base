// Preloaded network boundary only. No application module is replaced. The
// server records credential presence as a boolean, never the key/token itself.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { origin, key, token, blob, fixture } from './zendesk-data.mjs';
const home = process.env.HOME, real = globalThis.fetch;
if (!home?.includes('.business-connect-')) throw Error('Fixture requires an isolated test HOME');
const scenario = process.env.ZENDESK_CASE ?? 'Z0', data = fixture(scenario === 'Z'), counts = new Map();
if (scenario === 'source-locale') { data.articles[0].locale = 'fr'; data.articles[0].title = 'Translated list title'; }
if (scenario === 'sweep-change') { data.latest.generated_timestamp = 140; data.latest.subject = 'swept last version'; data.comments[10][1].body = 'Updated private reply'; }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(scenario === 'no-headers' ? {} : { 'ratelimit-remaining': '1000000', 'ratelimit-reset': '1' }), ...headers } });
const offset = (kind, rows) => json({ [kind]: rows, next_page: null });
const log = async event => appendFile(join(home, 'zendesk-requests.ndjson'), JSON.stringify({ ...event, at: Date.now() }) + '\n');
async function killAt(phase) {
 if (scenario !== `kill-${phase}`) return;
 const marker = join(home, `killed-${phase}`);
 try { await readFile(marker); } catch {
  await writeFile(marker, 'killed');
  process.kill(process.pid, 'SIGKILL');
 }
}
globalThis.fetch = async (input, init = {}) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (url.origin !== origin && url.origin !== 'https://example.com') return real(input, init);
 const sent = new Headers(init.headers).get('authorization'), method = init.method ?? 'GET';
 await log({ method, path: url.pathname + url.search, account: url.origin === origin, authorized: sent === `Bearer ${token}`, credentialPresent: !!sent, redirect: init.redirect });
 if (url.origin === 'https://example.com') return new Response(blob);
 if (url.pathname === '/oauth/tokens') {
  const value = JSON.parse(init.body);
  if (method !== 'POST' || value.client_id !== JSON.parse(key).client_id || value.client_secret !== JSON.parse(key).client_secret || value.expires_in !== 1800) return json({}, 401);
  return json({ access_token: token, token_type: 'Bearer', expires_in: 1800 });
 }
 if (sent !== `Bearer ${token}` || method !== 'GET') return json({}, 401);
 if (url.pathname === '/api/v2/oauth/tokens/current') return json({ token: { client_id: JSON.parse(key).client_id, token, scopes: scenario === 'write-scope' ? ['tickets:write'] : ['read'] } });
 const n = counts.get(url.pathname) ?? 0; counts.set(url.pathname, n + 1);
 if (url.pathname.includes('/incremental/tickets/')) {
  if (['retry-2','retry-600','retry-four'].includes(scenario) && n < (scenario === 'retry-four' ? 4 : 1)) return json({}, 429, { 'retry-after': scenario === 'retry-600' ? '600' : '2' });
  if (!url.searchParams.has('cursor')) return json({ tickets: data.tickets, end_of_stream: false, after_cursor: 'second', after_url: `${origin}/api/v2/incremental/tickets/cursor.json?cursor=second&per_page=1000` });
  await killAt('A');
  return json({ tickets: [data.latest], end_of_stream: true, after_cursor: 'last' });
 }
 const ticket = /\/tickets\/(\d+)\/comments/u.exec(url.pathname)?.[1];
 if (ticket) {
  const rows = data.comments[ticket];
  if (ticket === '10') {
   if (!url.searchParams.has('page[after]')) return json({ comments: [rows[0]], meta: { has_more: true }, links: { next: scenario === 'bad-page' ? 'https://elsewhere.example/api/v2/tickets/10/comments?page[after]=two' : `${origin}${url.pathname}.json?page[after]=two&page[size]=100&include_inline_images=true` } });
   await killAt('B');
   return json({ comments: [rows[1]], meta: { has_more: false }, links: { next: null } });
  }
  return json({ comments: [rows[url.searchParams.has('page') ? 1 : 0]], next_page: url.searchParams.has('page') ? null : `${origin}${url.pathname}.json?page=2&include_inline_images=true` });
 }
 if (url.pathname.startsWith('/attachments/')) {
  if (scenario.startsWith('redirect-')) {
   const locations = { 'redirect-public': 'https://example.com/customer.txt', 'redirect-http': 'http://example.com/customer.txt', 'redirect-ip': 'https://127.0.0.1/customer.txt', 'redirect-userinfo': 'https://user@example.com/customer.txt', 'redirect-local': 'https://internal.local/customer.txt', 'redirect-port': 'https://example.com:443/customer.txt' };
   return new Response(null, { status: 302, headers: { location: locations[scenario], 'ratelimit-remaining': '1000000', 'ratelimit-reset': '1' } });
  }
  return new Response(scenario === 'size-mismatch' ? Buffer.from('wrong bytes') : blob, { headers: { 'ratelimit-remaining': '1000000', 'ratelimit-reset': '1' } });
 }
 if (url.pathname === '/api/v2/incremental/users/cursor') return json({ users: data.users, end_of_stream: true });
 if (url.pathname === '/api/v2/incremental/organizations') return json({ organizations: data.organizations, end_of_stream: true });
 if (url.pathname === '/api/v2/ticket_fields') return offset('ticket_fields', data.ticket_fields);
 if (url.pathname.startsWith('/api/v2/help_center/')) {
  if (scenario === 'guide-404') return json({}, 404);
  if (url.pathname === '/api/v2/help_center/en-us/articles/8') return json({ article: fixture().articles[0] });
  const name = url.pathname.split('/').at(-1), kind = name === 'attachments' ? 'article_attachments' : name;
  if (kind === 'articles') await killAt('F');
  return data[kind] ? offset(kind, data[kind]) : json({}, 404);
 }
 return json({}, 404);
};
