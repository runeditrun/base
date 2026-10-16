import { createHash } from 'node:crypto';
import { assert, hash, resourceName } from '../deploy-kit/validation.mjs';
import { ownerWorkerName } from '../deploy-kit/owner.mjs';
import { siteDeclaration } from '../deploy-kit/site.mjs';

/* A seed's hosted demo at demo.<domain>: the Worker `rer deploy --demo` builds
 * from deploy-demo.json, as `rer deploy --site` builds the run site from
 * deploy-site.json. It is this folder's front Worker plus a Container class
 * running the seed's own image (`rer build --platform container`, workerd
 * engine), deployed by `wrangler deploy` with the image beside it. */

export const DEMO_FILES = ['worker.mjs', 'container.mjs', 'startup.mjs', 'placement.mjs', 'capacity.mjs', 'claim.mjs', 'pages.mjs', 'start-script.mjs', 'diagnostics.mjs', 'operator.mjs', 'measurement.mjs'];
const FRONT_SET = /^(?:RER_.*|SESSION_SECRET|SETUP_TOKEN|OWNER_EMAIL)$/;
const SECRET = /SECRET|TOKEN|PASSWORD|_KEY$/;
// Cloudflare Containers' predefined instance types, smallest first (developers.cloudflare.com/containers/platform-details/limits).
export const INSTANCE_TYPES = ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'];

/**
 * deploy-demo.json: `{ "version": 1, "domain": "run-lamp.com", "name": "Lamp" }`, plus optionally
 * `maxInstances` (concurrent demos, default 10), `instanceType` (one of INSTANCE_TYPES, default
 * "basic"), `ownerEmail` (the address the demo's owner signs in as, default owner@demo.invalid) and `settings`, the seed's plain demo settings (such as MAIL_PROVIDER: "development").
 * Settings never carry secrets or what the front sets. The app declaration's
 * container.hostVariables select hostname settings: the primary demo hostname
 * or its descendants, routed through the same visitor isolation.
 */
export function demoDeclaration(value, originVar) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && Object.keys(value).every(key => ['version', 'domain', 'name', 'maxInstances', 'instanceType', 'ownerEmail', 'settings', 'mode'].includes(key)), 'invalid-demo-declaration');
  assert(value.mode === undefined || ['container', 'loader'].includes(value.mode), 'invalid-demo-mode');
  siteDeclaration({ version: 1, domain: value.domain });
  assert(typeof value.name === 'string' && value.name.trim() === value.name && value.name.length > 0 && value.name.length <= 60 && !/[\p{Cc}\p{Cf}]/u.test(value.name), 'invalid-demo-name');
  const maxInstances = value.maxInstances ?? 10;
  assert(Number.isSafeInteger(maxInstances) && maxInstances >= 1 && maxInstances <= 100, 'invalid-demo-max-instances');
  const instanceType = value.instanceType ?? 'basic';
  assert(INSTANCE_TYPES.includes(instanceType), 'invalid-demo-instance-type');
  const ownerEmail = value.ownerEmail;
  assert(ownerEmail === undefined || (typeof ownerEmail === 'string' && ownerEmail.length <= 254 && /^[^\s@<>"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(ownerEmail)), 'invalid-demo-owner-email');
  const settings = value.settings ?? {};
  assert(settings && typeof settings === 'object' && !Array.isArray(settings) && Object.entries(settings).every(([name, setting]) =>
    /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !FRONT_SET.test(name) && !SECRET.test(name) && name !== originVar && typeof setting === 'string' && setting.length <= 1024), 'invalid-demo-settings');
  return { domain: value.domain, name: value.name, maxInstances, instanceType, ownerEmail, settings };
}

/** The demo Worker's name and its Wrangler configuration; no provider request. */
export function demoPlan({ project, environment, compatibilityDate, originVar, hostVariables = [], declaration, turnstileSiteKey }) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate ?? '') && /^[A-Z][A-Z0-9_]{0,63}$/.test(originVar ?? ''), 'invalid-plan');
  const { domain, name, maxInstances, instanceType, ownerEmail, settings } = demoDeclaration(declaration, originVar);
  const worker = `${ownerWorkerName(project, environment)}--demo`, hostname = `demo.${domain}`, container = worker.replace(/-+/g, '-');
  assert(resourceName(worker), 'owner-name-too-long');
  assert(Array.isArray(hostVariables) && hostVariables.every(variable => typeof variable === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(variable)), 'invalid-demo-host-variables');
  const declaredHosts = hostVariables.map(variable => {
    const host = settings[variable];
    assert(Object.hasOwn(settings, variable) && typeof host === 'string' && host.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) &&
      (host === hostname || host.endsWith(`.${hostname}`)), 'invalid-demo-host-setting');
    return host;
  });
  const secondaryHosts = [...new Set(declaredHosts)].filter(host => host !== hostname).sort();
  const hostnames = [hostname, ...secondaryHosts];
  // Rate limit namespaces are account-wide integers: one per demo Worker.
  const namespace = String(1000 + parseInt(createHash('sha256').update(worker).digest('hex').slice(0, 8), 16) % 1_000_000_000);
  const wrangler = {
    name: worker, main: 'worker.mjs', compatibility_date: compatibilityDate, workers_dev: false, preview_urls: false,
    routes: hostnames.map(pattern => ({ pattern, custom_domain: true })),
    observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: false } },
    vars: { DEMO_ORIGIN: `https://${hostname}`, DEMO_SITE: `https://${domain}`, DEMO_NAME: name, DEMO_ORIGIN_VAR: originVar, DEMO_MAX_INSTANCES: String(maxInstances), DEMO_SETTINGS: JSON.stringify(settings), DEMO_SECONDARY_ORIGINS: JSON.stringify(secondaryHosts.map(host => `https://${host}`)),
      ...(ownerEmail ? { DEMO_OWNER_EMAIL: ownerEmail } : {}), ...(turnstileSiteKey ? { TURNSTILE_SITE_KEY: turnstileSiteKey } : {}) },
    durable_objects: { bindings: [{ name: 'DEMO', class_name: 'DemoContainer' }, { name: 'CAPACITY', class_name: 'DemoCapacity' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['DemoContainer', 'DemoCapacity'] }],
    // Admission (DemoCapacity) holds live demos at maxInstances. The provider's
    // own limit keeps headroom for instances it still counts after a demo ends
    // or a start fails, and rollouts leave a live demo (at most an hour old) alone.
    containers: [{ name: container, class_name: 'DemoContainer', image: './image/Dockerfile', max_instances: maxInstances * 2, instance_type: instanceType, rollout_active_grace_period: 3600 }],
    ratelimits: [{ name: 'STARTS', namespace_id: namespace, simple: { limit: 3, period: 60 } }],
  };
  return { worker, hostname, hostnames, container, record: demoRecord({ worker, hostname, hostnames, container }), origin: `https://${hostname}`, maxInstances, instanceType, settings: Object.keys(settings), wrangler };
}

/** The demo's record of what `rer deploy --demo` creates, kept on the provider so a
 * fresh checkout (a CI runner) can remove it: the deploy writes it as the Worker
 * version's message, and only a Worker serving it is taken for the demo's own. */
export const demoRecord = ({ worker, hostname, hostnames = [hostname], container }) =>
  `rer-demo:${hash({ worker, hostname, container, ...(hostnames.length > 1 ? { hostnames } : {}) })}`;
