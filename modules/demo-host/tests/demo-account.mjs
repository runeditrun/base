import { createHash, randomUUID } from 'node:crypto';

/** Fake Cloudflare account for the hosted demo: Workers with versions and
 * deployments, Durable Object namespaces, Workers Custom Domains and Container
 * applications, at the API edge only. `deploy(plan)` leaves what `wrangler
 * deploy --message <plan.record>` makes from the demo's wrangler.json. Every
 * write is recorded. */
export function demoAccount() {
  const accountId = 'c'.repeat(32), token = 'test-only-demo-token', zoneId = 'd'.repeat(32);
  const state = { workers: new Map(), namespaces: [], domains: [], apps: [], writes: [] };
  const id = () => randomUUID().replaceAll('-', '');
  const ok = (result, result_info) => Response.json({ success: true, errors: [], result, ...result_info ? { result_info } : {} });
  const missing = () => Response.json({ success: false, errors: [{ code: 10007, message: 'not found' }] }, { status: 404 });
  const worker = (name, message) => {
    const version = { id: randomUUID(), annotations: { 'workers/message': message }, resources: {
      script: { etag: createHash('sha256').update(name).digest('hex'), handlers: ['fetch'], last_deployed_from: 'wrangler' },
      script_runtime: { compatibility_date: '2026-09-08', compatibility_flags: ['nodejs_compat'] },
      bindings: [{ name: 'TURNSTILE_SECRET_KEY', type: 'secret_text' }],
    } };
    state.workers.set(name, { versions: [version], deployments: [{ id: randomUUID(), versions: [{ version_id: version.id, percentage: 100 }] }], schedules: [] });
  };
  const namespace = (script, className) => { const row = { id: id(), name: `${script}_${className}`, script, class: className }; state.namespaces.push(row); return row; };
  const domain = (hostname, service) => state.domains.push({ id: id(), zone_id: zoneId, zone_name: hostname.split('.').slice(-2).join('.'), hostname, service, environment: 'production' });
  const app = (name, namespaceId) => state.apps.push({ id: randomUUID(), name, durable_objects: { namespace_id: namespaceId } });
  const fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', prefix = `/client/v4/accounts/${accountId}`;
    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith(prefix + '/')) throw Error(`unexpected request ${method} ${url}`);
    if (init.headers?.Authorization !== `Bearer ${token}`) throw Error('wrong token');
    const path = url.pathname.slice(prefix.length), query = url.searchParams;
    if (method !== 'GET') state.writes.push(`${method} ${path}${url.search}`);
    if (path === '/workers/domains' && method === 'GET') return ok(state.domains.filter(row => (!query.get('hostname') || row.hostname === query.get('hostname')) && (!query.get('service') || row.service === query.get('service'))));
    let match = /^\/workers\/domains\/([^/]+)$/.exec(path);
    if (match && method === 'DELETE') { const at = state.domains.findIndex(row => row.id === match[1]); if (at < 0) return missing(); state.domains.splice(at, 1); return ok(null); }
    if (path === '/containers/applications' && method === 'GET') return ok(state.apps);
    match = /^\/containers\/applications\/([^/]+)$/.exec(path);
    if (match && method === 'DELETE') { const at = state.apps.findIndex(row => row.id === match[1]); if (at < 0) return missing(); state.apps.splice(at, 1); return ok({}); }
    if (path === '/workers/durable_objects/namespaces') return ok(state.namespaces, { page: Number(query.get('page') ?? 1), per_page: 100, count: state.namespaces.length, total_count: state.namespaces.length, total_pages: 1 });
    match = /^\/workers\/scripts\/([^/]+)(\/.*)?$/.exec(path);
    if (match) {
      const [, name, rest = ''] = match, script = state.workers.get(name);
      if (!script) return missing();
      if (rest === '' && method === 'DELETE') { state.workers.delete(name); state.namespaces = state.namespaces.filter(row => row.script !== name); return ok(null); }
      if (rest === '/secrets' && method === 'PUT') {
        const previous = script.versions[0], body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
        const version = { ...structuredClone(previous), id: randomUUID(), annotations: { 'workers/triggered_by': 'secret' } };
        version.resources.script.last_deployed_from = 'api';
        version.resources.bindings = [...version.resources.bindings.filter(row => row.name !== body.name), { name: body.name, type: 'secret_text' }];
        script.versions.unshift(version);
        script.deployments.unshift({ id: randomUUID(), versions: [{ version_id: version.id, percentage: 100 }] });
        return ok({ name: body.name, type: 'secret_text' });
      }
      if (rest === '/settings') return ok({ bindings: script.versions[0].resources.bindings });
      if (rest === '/deployments') return ok({ deployments: script.deployments });
      if (rest === '/versions') return ok({ items: script.versions });
      const version = /^\/versions\/([^/]+)$/.exec(rest);
      if (version) return ok(script.versions.find(row => row.id === version[1]) ?? null);
      if (rest === '/schedules') { if (method === 'PUT') script.schedules = []; return ok({ schedules: script.schedules }); }
    }
    throw Error(`unmodelled request ${method} ${path}`);
  };
  return { accountId, token, state, fetch,
    /** What `wrangler deploy --message <plan.record>` leaves for the demo. */
    deploy(plan) {
      worker(plan.worker, plan.record);
      const container = namespace(plan.worker, 'DemoContainer'); namespace(plan.worker, 'DemoCapacity');
      app(plan.container, container.id); for (const hostname of plan.hostnames) domain(hostname, plan.worker);
    },
    /** Someone else's Worker with its own Custom Domain, Durable Object and Container application. */
    unrelated() { worker('someone-else', 'Deploy from the dashboard'); app('someone-else', namespace('someone-else', 'Box').id); domain('www.someone-else.test', 'someone-else'); },
    worker, domain, app, namespace };
}
