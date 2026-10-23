import { parseCron } from './cron.mjs';
import { objectClass } from './runtime.mjs';
import { DENY, admit, configBindings } from '../../ai/native/names.mjs';
export { hashedAsset, HASHED_ASSET, objectClass } from './runtime.mjs';

export const RUNTIME_FILES = ['runtime', 'worker', 'visitor', 'loader', 'd1', 'sql', 'r2', 'r2-store', 'queues', 'resources', 'cron', 'bridge', 'alarms'];
export const ISOLATE_FILES = ['bindings', 'namespace', 'r2-client', 'd1', 'sql', 'seed-object'];
/** The bindings a Loader demo installs in each visitor's isolate. Every name the built
 * configuration declares, the assets binding included, passes the runtime names first:
 * hosted demos have no approved AI path. */
export function nativeBindings(config) {
  admit(DENY, configBindings(config));
  for (const kind of ['kv_namespaces', 'services', 'workflows', 'ai', 'vectorize', 'hyperdrive', 'analytics_engine_datasets', 'browser', 'images', 'send_email', 'dispatch_namespaces', 'mtls_certificates', 'pipelines', 'secrets_store_secrets', 'unsafe', 'vpc_services', 'vpc_networks', 'ratelimits', 'worker_loaders', 'containers', 'ai_search_namespaces', 'ai_search', 'agent_memory', 'connect', 'artifacts', 'unsafe_hello_world', 'flagship', 'logfwdr', 'version_metadata']) {
    const value = config[kind];
    if (!value || (Array.isArray(value) && !value.length)) continue;
    const entries = Array.isArray(value) ? value : value.bindings ?? [value];
    for (const item of entries) throw new Error(`Loader demo cannot bind ${kind}: ${item.binding ?? item.name ?? kind}`);
  }
  const databases = (config.d1_databases ?? []).map(item => item.binding);
  const buckets = (config.r2_buckets ?? []).map(item => item.binding);
  const objects = config.durable_objects?.bindings ?? [];
  for (const item of objects) {
    if (item.script_name || item.environment) throw new Error(`Loader demo cannot bind external Durable Object: ${item.name}`);
    if (!/^[A-Za-z_$][\w$]*$/.test(item.class_name) || ['DemoApp', 'DemoDatabase'].includes(item.class_name)) throw new Error(`Loader demo cannot export Durable Object: ${item.name} (${item.class_name})`);
  }
  const queues = { producers: config.queues?.producers ?? [], consumers: config.queues?.consumers ?? [] };
  for (const consumer of queues.consumers) {
    if (consumer.type && consumer.type !== 'worker') throw new Error(`Loader demo cannot bind pull queue: ${consumer.queue}`);
  }
  for (const cron of config.triggers?.crons ?? []) {
    try { parseCron(cron); } catch { throw new Error(`Loader demo cannot schedule cron: ${cron}`); }
  }
  const names = [...databases, ...buckets, ...objects.map(item => item.name), ...queues.producers.map(item => item.binding)];
  for (const name of names) if (!/^[A-Za-z_][\w]*$/.test(name) || name.startsWith('RER_NATIVE_')) throw new Error(`Loader demo cannot bind reserved or invalid name: ${name}`);
  if (new Set(names).size !== names.length) throw new Error('Loader demo has duplicate binding names');
  return { databases, buckets, objects, queues, assets: config.assets?.binding ?? 'ASSETS' };
}

export const objectExports = bindings => (bindings.objects.length ? "\nimport { seedObject } from './seed-object.js';" : '') + bindings.objects.map(({ name, class_name }) =>
  `\nexport const ${objectClass(name)} = seedObject(application[${JSON.stringify(class_name)}], ${JSON.stringify(name)});`).join('');
