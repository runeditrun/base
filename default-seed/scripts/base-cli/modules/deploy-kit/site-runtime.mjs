import { assert, hash } from './validation.mjs';

/** Search is build metadata; the uploaded Worker still serves static assets. */
export function siteRuntime(runtime) {
  if (runtime === undefined) return undefined;
  assert(runtime && typeof runtime === 'object' && !Array.isArray(runtime)
    && Object.keys(runtime).sort().join() === 'assetHash,bindings,bytes,corpusHash,endpoint,gzipBytes,indexVersion,module,reindexed,reused,total,type'
    && runtime.type === 'docs-search' && runtime.module === 'docs-search' && runtime.endpoint === '/docs-search-index.json'
    && Array.isArray(runtime.bindings) && runtime.bindings.join() === 'ASSETS'
    && runtime.indexVersion === 2 && /^[a-f0-9]{64}$/.test(runtime.corpusHash) && /^[a-f0-9]{64}$/.test(runtime.assetHash)
    && ['bytes', 'gzipBytes', 'reindexed', 'reused', 'total'].every(key => Number.isSafeInteger(runtime[key]) && runtime[key] >= 0), 'invalid-site-runtime');
  return { ...runtime, bindings: ['ASSETS'] };
}

export const siteRuntimeBindings = () => [{ type: 'assets', name: 'ASSETS' }];

/** Read the exact serving version and its standard static Worker. */
export async function verifySiteRuntime(api, worker, versionId, source, module) {
  const replaced = () => Object.assign(new Error('owned-resource-replaced'), { resource: `worker:${worker}` });
  const version = await api.request(`/workers/scripts/${worker}/versions/${versionId}`);
  const bindings = version?.resources?.bindings;
  if (version?.id !== versionId || !Array.isArray(bindings) || bindings.length !== 1
    || bindings[0]?.name !== 'ASSETS' || bindings[0]?.type !== 'assets') throw replaced();
  const content = await api.workerContent(worker, versionId);
  const parts = [...content.parts];
  if (content.entry !== module || parts.length !== 1 || parts[0][0] !== module
    || typeof parts[0][1]?.arrayBuffer !== 'function'
    || hash(Buffer.from(await parts[0][1].arrayBuffer())) !== hash(source)) throw replaced();
}
