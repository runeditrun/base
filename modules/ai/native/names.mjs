import { approve, canonical, fail } from './policy.mjs';

/** Runtime names this module reads as installation authority: the policy variables,
 * the payer and bucket it checks, and the private token for bucket-privacy readback. */
export const AI_VARIABLES = Object.freeze(['RER_AI_REQUEST','RER_AI_AUTHORITY','RER_AI_ACCOUNT_ID','RER_AI_BUCKET_NAME']);
export const AI_PRIVACY_TOKEN = 'RER_AI_PRIVACY_TOKEN';
/** The whole namespace is reserved, including names no release reads yet. Case and prefix
 * lookalikes (rer_ai_authority, APP_RER_AI_AUTHORITY) are ordinary names. */
export const reservedAiName = name => typeof name === 'string' && name.startsWith('RER_AI_');

/* The one policy for which runtime names a seed or plan may emit. Every route that turns a
 * name into a Worker, container, hosted-demo or delivery runtime binding passes it through a
 * projection from `runtimeNames`: `emit` for what it uploads or packages, `admit` for what it
 * accepts or reads back. The allowlist: every ordinary name, lookalikes included; in the
 * reserved namespace only what an approved `ai` derives, the four policy variables with their
 * exact values and the private-token secret bound and sourced under its own name. DENY, the
 * projection without approval, admits no reserved name; a list that did not come through a
 * projection is treated as DENY's. Typed bindings: `plain_text` (a value), `secret_text` and
 * `inherit` (a secret, with its `environment` source when known), `var` (a seed-chosen
 * variable or setting name, never derived) and every resource, service or native family. */
const projections = new WeakSet(), lists = new WeakMap();

/** A projection: `ai` absent, or the approval ({request, authority, accountId, bucket}) the
 * allowlist's names and values are derived from. */
export function runtimeNames(ai) {
  let allow = null;
  if (ai !== undefined) {
    const approved = approve(ai.request, ai.authority);
    if (ai.accountId !== approved.accountId || typeof ai.bucket !== 'string' || !ai.bucket) fail('ai_policy_conflict');
    allow = Object.freeze({RER_AI_REQUEST:canonical(ai.request), RER_AI_AUTHORITY:canonical(ai.authority), RER_AI_ACCOUNT_ID:approved.accountId, RER_AI_BUCKET_NAME:ai.bucket});
  }
  const names = Object.freeze({allow});
  projections.add(names);
  return names;
}
export const DENY = runtimeNames();

function permitted(allow, {type, name, text, environment, optional}) {
  if (!reservedAiName(name) && !reservedAiName(environment)) return true;
  if (!allow) return false;
  if (type === 'plain_text') return environment === undefined && Object.hasOwn(allow, name) && text === allow[name];
  if (type === 'secret_text' || type === 'inherit') return name === AI_PRIVACY_TOKEN && (environment === undefined || environment === AI_PRIVACY_TOKEN) && optional !== true;
  return false;
}
const channel = type => ['plain_text','var'].includes(type) ? 'var' : ['secret_text','inherit'].includes(type) ? 'secret' : 'name';

/** Accept bindings supplied as input or read back from a runtime: each one is on the allowlist,
 * or the refusal is a typed `ai_policy_conflict` naming its channel and name. */
export function admit(names, bindings) {
  if (!projections.has(names)) throw new Error('runtime-names-unprojected');
  for (const binding of bindings) if (!permitted(names.allow, binding)) {
    throw Object.assign(new Error('ai_policy_conflict'), {code:'ai_policy_conflict', status:409, resource:`${channel(binding.type)}:${binding.name}`});
  }
  return bindings;
}
/** Emit bindings for an upload, copy, build or package: admitted, frozen, and remembered with
 * the projection that admitted them. */
export function emit(names, bindings) {
  const list = Object.freeze([...admit(names, bindings)]);
  lists.set(list, names);
  return list;
}
/** The projection an emitted list passed; DENY for any other list. */
export const projectionOf = list => lists.get(list) ?? DENY;

// Wrangler configuration families that bind a runtime name: each family's binding type and where
// its names sit (`field`: absent for a top-level list, a nested list's key, or null for one object).
const FAMILIES = {d1_databases:['d1'], r2_buckets:['r2_bucket'], kv_namespaces:['kv_namespace'], services:['service'], analytics_engine_datasets:['analytics_engine'],
  vectorize:['vectorize'], hyperdrive:['hyperdrive'], dispatch_namespaces:['dispatch_namespace'], mtls_certificates:['mtls_certificate'], pipelines:['pipelines'],
  secrets_store_secrets:['secrets_store_secret'], workflows:['workflow'], worker_loaders:['worker_loader'], vpc_services:['vpc_service'], vpc_networks:['vpc_network'],
  send_email:['send_email'], ratelimits:['ratelimit'], ai_search_namespaces:['ai_search_namespace'], ai_search:['ai_search'], agent_memory:['agent_memory'],
  artifacts:['artifacts'], flagship:['flagship'], unsafe_hello_world:['unsafe_hello_world'],
  queues:['queue','producers'], durable_objects:['durable_object_namespace','bindings'], unsafe:['unsafe','bindings'], logfwdr:['logfwdr','bindings'],
  ai:['ai',null], assets:['assets',null], browser:['browser',null], images:['images',null], version_metadata:['version_metadata',null]};
export const CONFIG_FAMILIES = Object.freeze(Object.fromEntries(Object.entries(FAMILIES).map(([key, [type, field]]) => [key, Object.freeze({type, field})])));
const list = value => Array.isArray(value) ? value : [];
const named = item => item?.binding ?? item?.name;

/** Every runtime binding a Wrangler-shaped configuration declares (its top level, as the
 * container, hosted-demo and owner renderers read it), typed for `admit` and `emit`. */
export function configBindings(config) {
  return [
    ...Object.entries(config?.vars ?? {}).map(([name, text]) => ({type:'plain_text', name, text})),
    ...Object.entries(CONFIG_FAMILIES).flatMap(([key, {type, field}]) => field === null ? (config?.[key]?.binding === undefined ? [] : [{type, name:config[key].binding}])
      : list(field === undefined ? config?.[key] : config?.[key]?.[field]).map(item => ({type, name:named(item)}))),
  ];
}
