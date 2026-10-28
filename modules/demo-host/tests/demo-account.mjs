import { randomUUID } from 'node:crypto';
import { hash } from '../../deploy-kit/validation.mjs';

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
      script: { etag: hash(name), handlers: ['fetch'], last_deployed_from: 'wrangler' },
      script_runtime: { compatibility_date: '2026-09-08', compatibility_flags: ['nodejs_compat'] },
      bindings: [{ name: 'TURNSTILE_SECRET_KEY', type: 'secret_text' }],
    } };
    state.workers.set(name, { versions: [version], deployments: [{ id: randomUUID(), versions: [{ version_id: version.id, percentage: 100 }] }], schedules: [], tag: id(), migration_tag: 'native-v2' });
  };
  const namespace = (script, className) => { const row = { id: id(), name: `${script}_${className}`, script, class: className }; state.namespaces.push(row); return row; };
  const domain = (hostname, service) => state.domains.push({ id: id(), zone_id: zoneId, zone_name: hostname.split('.').slice(-2).join('.'), hostname, service, environment: 'production' });
  const app = (name, namespaceId) => state.apps.push({ id: randomUUID(), name, durable_objects: { namespace_id: namespaceId } });
  const fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', prefix = `/client/v4/accounts/${accountId}`;
    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith(prefix + '/') && !url.pathname.startsWith('/client/v4/zones')) throw Error(`unexpected request ${method} ${url}`);
    if (init.headers?.Authorization !== `Bearer ${url.pathname.endsWith('/workers/assets/upload') ? 'test-asset-upload' : token}`) throw Error('wrong token');
    if (url.pathname === '/client/v4/zones') return ok([{ id: zoneId, name: 'test.run-fixture.test', account: { id: accountId } }]);
    if (url.pathname === `/client/v4/zones/${zoneId}/workers/routes`) return ok([]);
    const path = url.pathname.slice(prefix.length), query = url.searchParams;
    if (method !== 'GET') state.writes.push(`${method} ${path}${url.search}`);
    if (path === '/workers/assets/upload' && method === 'POST') return ok({ jwt: 'test-asset-completion' });
    const service = /^\/workers\/services\/([^/]+)$/.exec(path);
    if (service) {
      const script = state.workers.get(service[1]);
      return script ? ok({ default_environment: { environment: 'production', script: { tag: script.tag, migration_tag: script.migration_tag } } }) : missing();
    }
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
      if (rest === '/assets-upload-session' && method === 'POST') {
        const { manifest } = JSON.parse(init.body);
        return ok({ jwt: 'test-asset-upload', buckets: [Object.values(manifest).map(row => row.hash)] });
      }
      if (rest === '/versions' && method === 'POST') {
        const metadata = JSON.parse(await init.body.get('metadata').text()), previous = script.versions[0];
        const files = await Promise.all([...init.body].filter(([name]) => name !== 'metadata').map(async ([name, file]) => ({ name, sha256: hash(Buffer.from(await file.arrayBuffer())) })));
        const bindings = [...(metadata.bindings ?? []).map(row => row.type === 'inherit' ? previous.resources.bindings.find(held => held.name === row.name) : row.type === 'secret_text' ? { name: row.name, type: row.type } : row)];
        if (metadata.keep_bindings?.includes('secret_text')) for (const row of previous.resources.bindings.filter(row => row.type === 'secret_text')) if (!bindings.some(held => held.name === row.name)) bindings.push(row);
        const version = { id: randomUUID(), annotations: metadata.annotations, resources: { bindings,
          script: { etag: hash(files), handlers: ['fetch'], last_deployed_from: 'wrangler' },
          script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } };
        script.versions.unshift(version);
        return ok(version);
      }
      if (rest === '/deployments' && method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.versions.length !== 1 || body.versions[0].percentage !== 100 || !script.versions.some(row => row.id === body.versions[0].version_id)) throw Error('invalid deployment');
        const deployment = { id: randomUUID(), versions: body.versions };
        script.deployments.unshift(deployment); return ok(deployment);
      }
      if (rest === '/script-settings' && method === 'PATCH') return ok({});
      if (rest === '/subdomain') return ok({ enabled: false, previews_enabled: false });
      if (rest === '/domains/records' && method === 'PUT') {
        for (const origin of JSON.parse(init.body).origins) if (!state.domains.some(row => row.hostname === origin.hostname && row.service === name)) domain(origin.hostname, name);
        return ok({});
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
    deploy(plan, { native = false } = {}) {
      worker(plan.worker, plan.record);
      const container = namespace(plan.worker, native ? 'NativeDemo' : 'DemoContainer'); namespace(plan.worker, 'DemoCapacity');
      if (!native) app(plan.container, container.id); for (const hostname of plan.hostnames) domain(hostname, plan.worker);
    },
    /** Someone else's Worker with its own Custom Domain, Durable Object and Container application. */
    unrelated() { worker('someone-else', 'Deploy from the dashboard'); app('someone-else', namespace('someone-else', 'Box').id); domain('www.someone-else.test', 'someone-else'); },
    worker, domain, app, namespace };
}
