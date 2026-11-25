import { hash, identifier, stable, uuid } from './validation.mjs';
import { activeWorker, deployedFingerprint } from './worker.mjs';

export const settingsAdoptionNote = 'settings-only change adopted';

export function workerReplacementRecovery(deploy) {
  return `For a settings-only change, ${deploy} automatically records the new deployment when the script and bindings match. If the Worker was replaced or its bindings changed, use the checkout that deployed the live Worker or deploy to a new environment.`;
}

function bindingSnapshot(bindings, fingerprint) {
  if (!Array.isArray(bindings) || !bindings.every(row => identifier(row?.name) && typeof row.type === 'string')
    || new Set(bindings.map(row => row.name)).size !== bindings.length || deployedFingerprint({bindings}) !== fingerprint) return null;
  return stable([...bindings].sort((a,b) => a.name.localeCompare(b.name)));
}

function runtimeSettingsChanged(before, after) {
  const valid = runtime => typeof runtime?.compatibility_date === 'string'
    && (runtime.compatibility_flags === undefined || Array.isArray(runtime.compatibility_flags));
  if (!valid(before) || !valid(after)) return false;
  const split = ({limits,usage_model,compatibility_date,compatibility_flags = [],...resources}) =>
    ({settings:{limits:limits ?? null,usage_model,compatibility_date,compatibility_flags:[...compatibility_flags].sort()},resources});
  const prior = split(before), current = split(after);
  return stable(prior.resources) === stable(current.resources) && stable(prior.settings) !== stable(current.settings);
}

async function versionEvidence(read) {
  try { return await read(); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

// The legacy version endpoint exposes the script ETag. If it changed, compare
// the entry point and every module using Cloudflare's version-addressed API.
async function scriptContent(api, worker, versionId) {
  const version = await versionEvidence(() => api.request(`/workers/workers/${worker}/versions/${versionId}?include=modules`));
  if (version?.id !== versionId || typeof version.main_module !== 'string' || !Array.isArray(version.modules)
    || !version.modules.every(row => typeof row?.name === 'string' && typeof row.content_type === 'string' && typeof row.content_base64 === 'string')
    || new Set(version.modules.map(row => row.name)).size !== version.modules.length
    || !version.modules.some(row => row.name === version.main_module)) return null;
  const modules = version.modules.map(row => ({name:row.name,type:row.content_type,base64:row.content_base64}));
  return hash({entry:version.main_module,assets:version.assets?.config,modules:modules.sort((a,b) => a.name.localeCompare(b.name))});
}

/** Read-only proof of a settings change from the receipt's exact historical
 * version. PATCH can drop the version message, but must keep the build binding.
 * Opaque bindings are compared by the identities Cloudflare returns. */
export async function settingsSuccessor(api, worker, {accountId, worker:recordedWorker, receipt}, live) {
  const {provider, fingerprint} = receipt;
  if (!live || !uuid(provider?.versionId) || !uuid(provider.deploymentId) || typeof provider.etag !== 'string' || !provider.etag
    || live.versionId === provider.versionId || live.deploymentId === provider.deploymentId
    || accountId !== api.accountId || recordedWorker !== worker
    || receipt.accountId !== undefined && receipt.accountId !== accountId || receipt.worker !== undefined && receipt.worker !== worker
    || typeof fingerprint !== 'string' || !fingerprint) return null;

  const path = `/workers/scripts/${worker}/versions`;
  const anchor = await versionEvidence(() => api.request(`${path}/${provider.versionId}`));
  const prior = anchor?.resources, current = live.version.resources;
  if (anchor?.id !== provider.versionId || prior?.script?.etag !== provider.etag
    || !runtimeSettingsChanged(prior.script_runtime,current.script_runtime)) return null;
  const bindings = bindingSnapshot(prior.bindings,fingerprint);
  if (!bindings || bindings !== bindingSnapshot(current.bindings,fingerprint) || bindings !== bindingSnapshot(live.settings.bindings,fingerprint)) return null;
  // Service props can be absent in version readbacks even when set on upload.
  for (const {binding,props} of receipt.config?.services ?? []) if (props !== undefined
    && stable(props) !== stable(current.bindings.find(row => row.name === binding)?.props)) return null;

  const annotation = key => live.version.annotations?.[key] ?? live.settings.annotations?.[key];
  const message = annotation('workers/message');
  if (message !== undefined && message !== anchor.annotations?.['workers/message']) return null;
  if (['upload','version_upload','secret','rollback','promotion'].includes(annotation('workers/triggered_by'))) return null;
  // An intervening version could have changed an opaque binding even though
  // the successor's visible binding identities still match the receipt.
  const versions = (await api.request(path))?.items;
  if (versions?.[0]?.id !== live.versionId || versions?.[1]?.id !== provider.versionId) return null;

  if (live.etag !== provider.etag) {
    const [before, after] = await Promise.all([scriptContent(api,worker,provider.versionId),scriptContent(api,worker,live.versionId)]);
    if (!before || before !== after) return null;
  }
  const confirmed = await activeWorker(api,worker);
  return confirmed?.versionId === live.versionId && confirmed.deploymentId === live.deploymentId && confirmed.etag === live.etag
    && bindings === bindingSnapshot(confirmed.settings.bindings,fingerprint) ? confirmed : null;
}
