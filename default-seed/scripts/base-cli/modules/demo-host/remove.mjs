import { ownedBucket, removeBucket } from './native/deploy-r2.mjs';
import { assert } from '../deploy-kit/validation.mjs';
import { workerSettings } from '../deploy-kit/owner.mjs';
import { servedVersion } from '../deploy-kit/site.mjs';
import { deleteWorker } from '../deploy-kit/teardown.mjs';

/* `rer deploy --demo --remove --yes`: remove the hosted demo `rer deploy --demo`
 * made for this environment, by exact provider ids, and nothing else. What the
 * deploy made: the front Worker (its Durable Object namespaces go with it), the
 * Workers Custom Domains on the primary demo hostname and declared descendants
 * (Cloudflare adds and removes their DNS records with them), and the Container application `wrangler deploy` created for
 * the Worker's DemoContainer namespace. It makes no D1, KV, R2, queue or DNS
 * record of its own: the domain's record is Cloudflare's, and goes with it.
 *
 * The Worker is the demo's own only while it serves the version carrying the
 * demo's record (plan.mjs `demoRecord`). The domain is the demo's only while it
 * routes to that Worker, the Container application only while it belongs to
 * that Worker's DemoContainer namespace. Anything else of those names, or
 * attached to that Worker, is refused before the first delete. The Worker goes
 * last, so a run cut short leaves the record for the next one; once everything
 * is gone a second run is a no-op. */

function refuse(code, resource) { const error = new Error(code); error.resource = resource; return error; }
const rows = value => { assert(Array.isArray(value), 'provider-invalid-list'); return value; };

/** What exists of the demo now, each with its exact id; refuses whatever is not provably the demo's. */
async function inventory(api, plan) {
  const named = (await Promise.all(plan.hostnames.map(async hostname =>
    rows(await api.request(`/workers/domains?hostname=${hostname}`)).filter(row => row?.hostname === hostname)))).flat();
  const attached = rows(await api.request(`/workers/domains?service=${plan.worker}`)).filter(row => row?.service === plan.worker);
  const apps = rows(await api.request('/containers/applications')).filter(row => row?.name === plan.container);
  const namespaces = rows(await api.list('/workers/durable_objects/namespaces')).filter(row => row?.script === plan.worker);
  const settings = await workerSettings(api, plan.worker), worker = settings !== null;
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
  const container = namespaces.find(row => row.class === 'DemoContainer')?.id;
  for (const app of apps) if (!container || app.durable_objects?.namespace_id !== container) throw refuse('resource-name-collision', `container:${plan.container}`);
  return { worker, domains: named, apps, bucket: worker ? await ownedBucket(api, plan, settings) : null };
}

export async function demoRemove({ api, plan, sleep }) {
  const found = await inventory(api, plan);
  if (!found.worker) return { worker: plan.worker, removed: [], remaining: [], alreadyRemoved: true };
  const removed = [];
  for (const domain of found.domains) {
    await api.request(`/workers/domains/${domain.id}`, { method: 'DELETE' });
    removed.push(`domain:${domain.hostname}`);
  }
  for (const app of found.apps) { await api.request(`/containers/applications/${app.id}`, { method: 'DELETE' }); removed.push(`container:${plan.container}`); }
  if (found.bucket) { await removeBucket(api, found.bucket); removed.push(`r2:${found.bucket.name}`); }
  await deleteWorker({ api, worker: plan.worker, ...sleep ? { sleep } : {} });
  removed.push(`worker:${plan.worker}`);
  // Read back: nothing of the demo is listed any more.
  const remaining = [];
  if (await workerSettings(api, plan.worker) !== null) remaining.push(`worker:${plan.worker}`);
  for (const row of rows(await api.list('/workers/durable_objects/namespaces'))) if (row?.script === plan.worker) remaining.push(`durable-object:${row.class}`);
  const domains = await Promise.all(plan.hostnames.map(async hostname => ({ hostname, rows: rows(await api.request(`/workers/domains?hostname=${hostname}`)) })));
  for (const { hostname, rows: listed } of domains) if (listed.some(row => row?.hostname === hostname)) remaining.push(`domain:${hostname}`);
  const apps = rows(await api.request('/containers/applications'));
  for (const app of found.apps) if (apps.some(row => row?.id === app.id)) remaining.push(`container:${plan.container}`);
  if (remaining.length) { const error = new Error('remove-incomplete'); error.remaining = remaining; error.removed = removed.filter(item => !remaining.includes(item)); throw error; }
  return { worker: plan.worker, removed, remaining: [] };
}
