// Test-only vendor network edge, preloaded with --import: answers the shipped
// UptimeRobot adapter's fixed HTTPS origin with two saved v3 monitor pages and
// passes every other request to the real fetch. The key it expects is the one
// the owner stored in the fixture OS credential store (os-edge.mjs).
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.HOME, origin = 'https://api.uptimerobot.com', real = globalThis.fetch;
if (!root?.includes('.business-connect-')) throw Error('Fixture requires an isolated test HOME');
export const monitors = Array.from({ length: 600 }, (_, index) => ({ id: 800000 + index, friendlyName: `Fixture monitor ${index}`,
 url: `https://status-fixture.example/health/${index}`, type: 'HTTP', interval: 300, status: 'UP' }));
const pages = { '': { data: monitors.slice(0, 400), nextLink: `${origin}/v3/monitors?limit=200&cursor=page2` }, page2: { data: monitors.slice(400), nextLink: null } };

globalThis.fetch = async (input, init = {}) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (url.origin !== origin) return real(input, init);
 const stored = JSON.parse(await readFile(join(root, 'fake-keychain.json'), 'utf8'))['vendor:uptimerobot:read'];
 const authorized = new Headers(init.headers).get('authorization') === `Bearer ${stored}`;
 await appendFile(join(root, 'vendor-requests.log'), `${url.pathname}${url.search} ${authorized ? 'authorized' : 'refused'}\n`);
 if (!authorized) return new Response('{"error":"unauthorized"}', { status: 401 });
 const page = url.pathname === '/v3/monitors' && pages[url.searchParams.get('cursor') ?? ''];
 return page ? new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 });
};
