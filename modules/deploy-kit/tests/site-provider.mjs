import { randomUUID } from 'node:crypto';
import { providerFixture } from './provider-fixture.mjs';

/** Fake Cloudflare account for run site tests: the shared fixture's Worker,
 * version, asset and subdomain endpoints, plus one zone and Workers Custom
 * Domains. Every zone ruleset path answers 403, as for a token without
 * Single Redirect permission. Every request is recorded. */
export function siteProvider({ domain = 'run-example.test', zone = true } = {}) {
  const fixture = providerFixture({ handlers: ['fetch'] });
  const { state, accountId, token } = fixture;
  const zoneId = 'b'.repeat(32);
  state.zones = zone ? [{ id: zoneId, name: domain, account: { id: accountId } }] : [];
  state.domains = [];
  const ok = result => Response.json({ success: true, errors: [], result });
  const fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET';
    if (url.origin !== 'https://api.cloudflare.com') return fixture.fetch(input, init);
    if (init.headers?.Authorization !== `Bearer ${token}` && !url.pathname.endsWith('/workers/assets/upload')) throw Error('wrong token');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/client/v4/zones') {
      state.calls.push({ method, path: '/zones', search: url.search });
      return ok(state.zones.filter(row => row.name === url.searchParams.get('name') && row.account.id === url.searchParams.get('account.id')));
    }
    if (/^\/client\/v4\/zones\/[^/]+\/rulesets(?:\/|$)/.test(url.pathname)) {
      state.calls.push({ method, path: url.pathname.slice('/client/v4'.length) });
      return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    }
    if (url.pathname === `/client/v4/accounts/${accountId}/workers/domains`) {
      const path = '/workers/domains';
      state.calls.push({ method, path, search: url.search });
      if (method === 'GET') return ok(state.domains.filter(row => !url.searchParams.get('zone_id') || row.zone_id === url.searchParams.get('zone_id')));
      state.writes.push({ method, path, body });
      if (state.domains.some(row => row.hostname === body.hostname)) return Response.json({ success: false, errors: [{ code: 100117, message: 'hostname already attached' }] }, { status: 409 });
      const row = { id: randomUUID().replaceAll('-', ''), zone_id: body.zone_id, zone_name: domain, hostname: body.hostname, service: body.service, environment: body.environment };
      state.domains.push(row);
      return ok(row);
    }
    return fixture.fetch(input, init);
  };
  return { ...fixture, fetch, zoneId,
    /** A Custom Domain someone else attached to another Worker. */
    foreignDomain(hostname, service = 'someone-elses-worker') { state.domains.push({ id: randomUUID().replaceAll('-', ''), zone_id: zoneId, zone_name: domain, hostname, service, environment: 'production' }); },
    /** A Worker of the site's name that this kit did not create. */
    foreignWorker() { const id = randomUUID(); state.settings = { bindings: [] }; state.version = { id, annotations: { 'workers/message': 'Deploy from the dashboard' } }; state.versions = [state.version]; state.deployments = [{ id: randomUUID(), versions: [{ version_id: id, percentage: 100 }] }]; },
    /** A dashboard rollback: a new deployment serving the version before the newest. */
    rollback() { state.deployments = [{ id: randomUUID(), annotations: { 'workers/triggered_by': 'rollback' }, versions: [{ version_id: state.versions[1].id, percentage: 100 }] }, ...state.deployments]; } };
}
