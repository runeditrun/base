import { assert, hash } from './validation.mjs';
import { searchPolicy } from '../site/docs-search/policy.ts';

/** Only the immutable Base docs-search bundle may extend the site Worker. */
export function siteRuntime(runtime) {
  if (runtime === undefined) return undefined;
  assert(runtime && typeof runtime === 'object' && !Array.isArray(runtime)
    && Object.keys(runtime).sort().join() === 'bindings,corpusHash,endpoint,model,module,pooling,source,type'
    && runtime.type === 'docs-search' && runtime.module === 'docs-search' && runtime.endpoint === '/docs/search'
    && Array.isArray(runtime.bindings) && runtime.bindings.join() === 'ASSETS,AI,SEARCH_RATE_LIMITER'
    && typeof runtime.model === 'string' && runtime.model.trim().length > 0 && runtime.pooling === 'cls'
    && typeof runtime.corpusHash === 'string' && /^[a-f0-9]{64}$/.test(runtime.corpusHash)
    && typeof runtime.source === 'string' && runtime.source.length > 0, 'invalid-site-runtime');
  return { ...runtime, bindings: ['ASSETS', 'AI', 'SEARCH_RATE_LIMITER'] };
}

/** Stable per Worker; keys also include the origin and a hashed visitor. No
 * provider resource is created outside the version's binding metadata. */
export const siteRateLimit = worker => ({
  type: 'ratelimit', name: 'SEARCH_RATE_LIMITER',
  namespace_id: String(parseInt(hash(worker).slice(0, 12), 16) + 1),
  simple: { limit: searchPolicy.limit, period: searchPolicy.period },
});
export const siteRuntimeBindings = (runtime, worker) => [{ type: 'assets', name: 'ASSETS' },
  ...(runtime ? [{ type: 'ai', name: 'AI' }, siteRateLimit(worker)] : [])];

/** Read the exact version, never Worker-scoped settings or seed annotations.
 * Source equality proves the embedded corpus/model/pooling contract, including
 * its executable implementation, rather than trusting a claimed source digest. */
export async function verifySiteRuntime(api, worker, versionId, runtime, module) {
  const replaced = () => Object.assign(new Error('owned-resource-replaced'), { resource: `worker:${worker}` });
  const version = await api.request(`/workers/scripts/${worker}/versions/${versionId}`);
  const bindings = version?.resources?.bindings;
  const expected = siteRuntimeBindings(runtime, worker);
  if (version?.id !== versionId || !Array.isArray(bindings) || bindings.length !== expected.length
    || expected.some(binding => bindings.filter(row => row?.name === binding.name && row.type === binding.type
      && (binding.type !== 'ratelimit' || String(row.namespace_id) === binding.namespace_id
        && row.simple?.limit === binding.simple.limit && row.simple?.period === binding.simple.period)).length !== 1)) throw replaced();
  const content = await api.workerContent(worker, versionId);
  const parts = [...content.parts];
  if (content.entry !== module || parts.length !== 1 || parts[0][0] !== module
    || typeof parts[0][1]?.arrayBuffer !== 'function'
    || hash(Buffer.from(await parts[0][1].arrayBuffer())) !== hash(runtime.source)) throw replaced();
}
