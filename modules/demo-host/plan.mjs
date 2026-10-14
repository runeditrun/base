import { createHash } from 'node:crypto';
import { assert, resourceName } from '../deploy-kit/validation.mjs';
import { ownerWorkerName } from '../deploy-kit/owner.mjs';
import { siteDeclaration } from '../deploy-kit/site.mjs';

/* A seed's hosted demo at demo.<domain>: the Worker `rer deploy --demo` builds
 * from deploy-demo.json, as `rer deploy --site` builds the run site from
 * deploy-site.json. It is this folder's front Worker plus a Container class
 * running the seed's own image (`rer build --platform container`, workerd
 * engine), deployed by `wrangler deploy` with the image beside it. */

export const DEMO_FILES = ['worker.mjs', 'container.mjs', 'capacity.mjs', 'claim.mjs', 'pages.mjs'];
const FRONT_SET = /^(?:RER_.*|SESSION_SECRET|SETUP_TOKEN|OWNER_EMAIL)$/;
const SECRET = /SECRET|TOKEN|PASSWORD|_KEY$/;

/**
 * deploy-demo.json: `{ "version": 1, "domain": "run-lamp.com", "name": "Lamp" }`, plus optionally
 * `maxInstances` (concurrent demos, default 10) and `settings`, the seed's plain demo settings
 * (such as MAIL_PROVIDER: "development"). Settings never carry secrets or what the front sets.
 */
export function demoDeclaration(value, originVar) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && Object.keys(value).every(key => ['version', 'domain', 'name', 'maxInstances', 'settings'].includes(key)), 'invalid-demo-declaration');
  siteDeclaration({ version: 1, domain: value.domain });
  assert(typeof value.name === 'string' && value.name.trim() === value.name && value.name.length > 0 && value.name.length <= 60 && !/[\p{Cc}\p{Cf}]/u.test(value.name), 'invalid-demo-name');
  const maxInstances = value.maxInstances ?? 10;
  assert(Number.isSafeInteger(maxInstances) && maxInstances >= 1 && maxInstances <= 100, 'invalid-demo-max-instances');
  const settings = value.settings ?? {};
  assert(settings && typeof settings === 'object' && !Array.isArray(settings) && Object.entries(settings).every(([name, setting]) =>
    /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !FRONT_SET.test(name) && !SECRET.test(name) && name !== originVar && typeof setting === 'string' && setting.length <= 1024), 'invalid-demo-settings');
  return { domain: value.domain, name: value.name, maxInstances, settings };
}

/** The demo Worker's name and its Wrangler configuration; no provider request. */
export function demoPlan({ project, environment, compatibilityDate, originVar, declaration, turnstileSiteKey }) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate ?? '') && /^[A-Z][A-Z0-9_]{0,63}$/.test(originVar ?? ''), 'invalid-plan');
  const { domain, name, maxInstances, settings } = demoDeclaration(declaration, originVar);
  const worker = `${ownerWorkerName(project, environment)}--demo`, hostname = `demo.${domain}`;
  assert(resourceName(worker), 'owner-name-too-long');
  // Rate limit namespaces are account-wide integers: one per demo Worker.
  const namespace = String(1000 + parseInt(createHash('sha256').update(worker).digest('hex').slice(0, 8), 16) % 1_000_000_000);
  const wrangler = {
    name: worker, main: 'worker.mjs', compatibility_date: compatibilityDate, workers_dev: false, preview_urls: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    vars: { DEMO_ORIGIN: `https://${hostname}`, DEMO_SITE: `https://${domain}`, DEMO_NAME: name, DEMO_ORIGIN_VAR: originVar, DEMO_MAX_INSTANCES: String(maxInstances), DEMO_SETTINGS: JSON.stringify(settings),
      ...(turnstileSiteKey ? { TURNSTILE_SITE_KEY: turnstileSiteKey } : {}) },
    durable_objects: { bindings: [{ name: 'DEMO', class_name: 'DemoContainer' }, { name: 'CAPACITY', class_name: 'DemoCapacity' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['DemoContainer', 'DemoCapacity'] }],
    containers: [{ class_name: 'DemoContainer', image: './image/Dockerfile', max_instances: maxInstances, instance_type: 'basic' }],
    ratelimits: [{ name: 'STARTS', namespace_id: namespace, simple: { limit: 3, period: 60 } }],
  };
  return { worker, hostname, origin: `https://${hostname}`, maxInstances, settings: Object.keys(settings), wrangler };
}
