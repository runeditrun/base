import { assert } from '../deploy-kit/validation.mjs';
import { workerSettings } from '../deploy-kit/owner.mjs';
import { servedVersion } from '../deploy-kit/site.mjs';
import { deleteWorker } from '../deploy-kit/teardown.mjs';

// Exact-id teardown and ownership inventory, shared by native upgrades.
// The Worker is deleted last so interrupted removal retains its ownership record.

function refuse(code, resource) { const error = new Error(code); error.resource = resource; return error; }
const rows = value => { assert(Array.isArray(value), 'provider-invalid-list'); return value; };

/** What exists of the demo now, each with its exact id; refuses whatever is not provably the demo's. */
export async function demoInventory(api, plan) {
  const named = (await Promise.all(plan.hostnames.map(async hostname =>
    rows(await api.request(`/workers/domains?hostname=${hostname}`)).filter(row => row?.hostname === hostname)))).flat();
  const attached = rows(await api.request(`/workers/domains?service=${plan.worker}`)).filter(row => row?.service === plan.worker);
  const namespaces = rows(await api.list('/workers/durable_objects/namespaces')).filter(row => row?.script === plan.worker);
  const settings = await workerSettings(api, plan.worker);
  const worker = settings !== null;
  const container = namespaces.find(row => row.class === 'DemoContainer')?.id;
  const apps = container ? rows(await api.request('/containers/applications')).filter(row => row?.name === plan.container || row?.durable_objects?.namespace_id === container) : [];
  for (const row of named) if (row.service !== plan.worker) throw refuse('resource-name-collision', `domain:${row.hostname}`);
  if (worker) {
    const served = await servedVersion(api, plan.worker);
    if (served.annotation !== plan.record) throw refuse('resource-name-collision', `worker:${plan.worker}`);
    if (!served.current) throw refuse('owned-resource-replaced', `worker:${plan.worker}`);
    for (const row of attached) if (!plan.hostnames.includes(row.hostname)) throw refuse('resource-not-in-record', `domain:${row.hostname}`);
  } else if (named.length || attached.length || apps.length) {
    // Without the Worker nothing proves these are the demo's.
    throw refuse('uncertain-resource-create', named[0] || attached[0] ? `domain:${(named[0] ?? attached[0]).hostname}` : `container:${plan.container}`);
  }
  for (const app of apps) if (app.name !== plan.container || !container || app.durable_objects?.namespace_id !== container) throw refuse('resource-name-collision', `container:${plan.container}`);
  return { worker, settings, namespaces, domains: named, apps };
}

export async function demoRemove({ api, plan, sleep }) {
  const found = await demoInventory(api, plan);
  if (!found.worker) return { worker: plan.worker, removed: [], remaining: [], alreadyRemoved: true };
  const removed = [];
  for (const domain of found.domains) {
    await api.request(`/workers/domains/${domain.id}`, { method: 'DELETE' });
    removed.push(`domain:${domain.hostname}`);
  }
  for (const app of found.apps) { await api.request(`/containers/applications/${app.id}`, { method: 'DELETE' }); removed.push(`container:${plan.container}`); }
  await deleteWorker({ api, worker: plan.worker, ...sleep ? { sleep } : {} });
  removed.push(`worker:${plan.worker}`);
  // Read back: nothing of the demo is listed any more.
  const remaining = [];
  if (await workerSettings(api, plan.worker) !== null) remaining.push(`worker:${plan.worker}`);
  for (const row of rows(await api.list('/workers/durable_objects/namespaces'))) if (row?.script === plan.worker) remaining.push(`durable-object:${row.class}`);
  const domains = await Promise.all(plan.hostnames.map(async hostname => ({ hostname, rows: rows(await api.request(`/workers/domains?hostname=${hostname}`)) })));
  for (const { hostname, rows: listed } of domains) if (listed.some(row => row?.hostname === hostname)) remaining.push(`domain:${hostname}`);
  const apps = found.apps.length ? rows(await api.request('/containers/applications')) : [];
  for (const app of found.apps) if (apps.some(row => row?.id === app.id)) remaining.push(`container:${plan.container}`);
  if (remaining.length) { const error = new Error('remove-incomplete'); error.remaining = remaining; error.removed = removed.filter(item => !remaining.includes(item)); throw error; }
  return { worker: plan.worker, removed, remaining: [] };
}
