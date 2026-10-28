// Test-only vendor network edge, preloaded with --import: answers the shipped
// adapters' HTTPS origins (UptimeRobot, Sentry US, PagerDuty and a Sorry public
// page) with saved responses (vendor-data.mjs) and passes every other request to
// the real fetch. The key each vendor expects is the one the owner stored in the
// fixture OS credential store (os-edge.mjs); Sorry's public page takes none.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sentry, pagerduty, sorry } from './vendor-data.mjs';

const root = process.env.HOME, real = globalThis.fetch;
if (!root?.includes('.business-connect-')) throw Error('Fixture requires an isolated test HOME');
const uptimeOrigin = 'https://api.uptimerobot.com';
export const monitors = Array.from({ length: 600 }, (_, index) => ({ id: 800000 + index, friendlyName: `Fixture monitor ${index}`,
 url: `https://status-fixture.example/health/${index}`, type: 'HTTP', interval: 300, status: 'UP' }));
const pages = { '': { data: monitors.slice(0, 400), nextLink: `${uptimeOrigin}/v3/monitors?limit=200&cursor=page2` }, page2: { data: monitors.slice(400), nextLink: null } };

const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
const missing = () => new Response('{"error":"not found"}', { status: 404 });
const stored = async vendor => JSON.parse(await readFile(join(root, 'fake-keychain.json'), 'utf8').catch(() => '{}'))[`vendor:${vendor}:read`];

function uptimerobot(url) {
 const page = url.pathname === '/v3/monitors' && pages[url.searchParams.get('cursor') ?? ''];
 return page ? json(page) : missing();
}
function sentryAnswer(url) {
 const prefix = `/api/0/organizations/${sentry.organization.slug}/`, kind = url.pathname.startsWith(prefix) && url.pathname.slice(prefix.length, -1);
 const link = cursor => `<${url.origin}${url.pathname}>; rel="previous"; results="false"; cursor="0:0:1", <${url.origin}${url.pathname}>; rel="next"; results="${cursor ? 'true' : 'false'}"; cursor="${cursor ?? '0:100:0'}"`;
 if (kind === 'projects') return json(sentry.projects, { link: link(null) });
 if (kind === 'releases') return json(sentry.releases, { link: link(null) });
 if (kind === 'issues') {
  const rows = sentry.issues[url.searchParams.get('project')];
  if (!rows) return missing();
  const offset = url.searchParams.get('cursor') === '0:100:0' ? 100 : 0;
  return json(rows.slice(offset, offset + 100), { link: link(offset + 100 < rows.length ? '0:100:0' : null) });
 }
 return missing();
}
function pagerdutyAnswer(url) {
 const offset = Number(url.searchParams.get('offset') ?? 0), since = url.searchParams.get('since'), until = url.searchParams.get('until');
 const listed = (kind, rows) => json({ [kind]: rows.slice(offset, offset + 100), limit: 100, offset, more: offset + 100 < rows.length, total: null });
 const schedule = pagerduty.schedules.find(item => url.pathname.startsWith(`/schedules/${item.id}`));
 if (url.pathname === '/users') return listed('users', pagerduty.users);
 if (url.pathname === '/schedules') return listed('schedules', pagerduty.schedules.map(item => ({ id: item.id, type: 'schedule', summary: item.name, name: item.name })));
 if (url.pathname === '/escalation_policies') return listed('escalation_policies', [pagerduty.policy]);
 if (schedule && url.pathname === `/schedules/${schedule.id}`) return json(pagerduty.detail(schedule, since, until));
 if (schedule && url.pathname === `/schedules/${schedule.id}/overrides`) return json({ overrides: [pagerduty.override(schedule, since)] });
 return missing();
}
function sorryAnswer(url) {
 const number = Number(url.searchParams.get('page') ?? 1), notice = /^\/api\/v1\/notices\/(\d+)$/.exec(url.pathname)?.[1];
 if (url.pathname === '/api/v1/status') return json({ page: sorry.page });
 if (url.pathname === '/api/v1/components') return json(sorry.list(sorry.components, 'components', number));
 if (url.pathname === '/api/v1/notices') return json(sorry.list(sorry.notices, 'notices', number));
 const found = notice && sorry.notices.find(item => String(item.id) === notice);
 return found ? json({ notice: found }) : missing();
}
const vendors = {
 [uptimeOrigin]: { vendor: 'uptimerobot', authorization: key => `Bearer ${key}`, answer: uptimerobot },
 'https://us.sentry.io': { vendor: 'sentry', authorization: key => `Bearer ${key}`, answer: sentryAnswer },
 'https://api.pagerduty.com': { vendor: 'pagerduty', authorization: key => `Token token=${key}`, answer: pagerdutyAnswer },
 [sorry.origin]: { vendor: 'sorry', authorization: null, answer: sorryAnswer },
};

globalThis.fetch = async (input, init = {}) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url), edge = vendors[url.origin];
 if (!edge) return real(input, init);
 const sent = new Headers(init.headers).get('authorization');
 const access = edge.authorization ? (sent && sent === edge.authorization(await stored(edge.vendor)) ? 'authorized' : 'refused') : sent ? 'refused' : 'anonymous';
 await appendFile(join(root, 'vendor-requests.log'), `${edge.vendor === 'uptimerobot' ? '' : `${url.host} `}${url.pathname}${url.search} ${access}\n`);
 if (access === 'refused') return new Response('{"error":"unauthorized"}', { status: 401 });
 return edge.answer(url);
};
