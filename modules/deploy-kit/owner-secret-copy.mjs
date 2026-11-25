import { assert, stable, uuid } from './validation.mjs';
import { scriptContent } from './owner-settings.mjs';

// Several secrets change as ONE Worker version, so a half-changed group never runs.
// Cloudflare's per-secret calls each deploy a version of their own, and its settings
// call adds secrets but never removes one (both measured on 17 October 2026). A copy
// of the live version does both: its own modules and assets, every version setting
// the live version runs with (compatibility date and flags, CPU and subrequest limits,
// usage model, placement), every binding inherited except the named secrets, which it
// sets or leaves out. Script-level settings (Cron Triggers, observability, logpush,
// tail consumers) belong to the script, not the version, and a version upload leaves
// them as they are. Version upload metadata that omits a setting gets Cloudflare's
// default, not the live value: a copy without `limits` dropped an explicit
// limits.cpu_ms (ChargeDesk Uptime, 25 November 2026). So the copy is read back before
// it is deployed and is deployed only when it runs exactly what the live version runs.
// The copy carries a marker rer saved before uploading it, so a copy whose answer was
// lost, or that was uploaded but not yet deployed, is recognised as this change and no other.
export const copyMessage = marker => `rer-secrets:${marker}`;

// Placement fields Cloudflare reports about its own analysis; an upload does not take them.
const placementReport = new Set(['status','last_analyzed_at']);

/** The version settings of the live Worker, as upload metadata. */
function liveSettings(live) {
  const runtime = live.version?.resources?.script_runtime;
  assert(typeof runtime?.compatibility_date === 'string', 'invalid-active-version');
  const {compatibility_date, compatibility_flags = [], limits, usage_model} = runtime;
  const placement = Object.fromEntries(Object.entries(live.settings?.placement ?? {}).filter(([key]) => !placementReport.has(key)));
  return {compatibility_date, compatibility_flags,
    ...(limits === undefined ? {} : {limits}), ...(usage_model === undefined ? {} : {usage_model}),
    ...(Object.keys(placement).length ? {placement} : {})};
}

const others = (version, named) => {
  const bindings = version?.resources?.bindings;
  return Array.isArray(bindings) ? stable(bindings.filter(row => !named.has(row.name)).map(({name, type}) => ({name, type})).sort((a,b) => a.name.localeCompare(b.name))) : null;
};
/** A copy runs what `live` (a version) runs: the same version settings and every binding it does not name. */
export const keepsLive = (copy, live, named) => stable(copy?.resources?.script_runtime ?? null) === stable(live?.resources?.script_runtime ?? null)
  && others(copy, named) !== null && others(copy, named) === others(live, named);

/** The version settings a copy runs with that differ from its starting version's (empty when none). */
export function settingsDrift(copy, start) {
  const before = start?.resources?.script_runtime ?? {}, after = copy?.resources?.script_runtime ?? {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => stable(before[key] ?? null) !== stable(after[key] ?? null)).sort();
}

/** The copy runs the starting version's own code: the same script etag, or the same entry point and modules. */
export async function sameScript(api, worker, start, copy) {
  if (start.etag === copy.etag) return true;
  const [before, after] = await Promise.all([scriptContent(api, worker, start.versionId), scriptContent(api, worker, copy.versionId)]);
  return Boolean(before) && before === after;
}

/** Upload the copy (not yet deployed), read it back, and return its version id. A copy that
 * does not run what the live version runs is refused (`secret-copy-settings-changed`) and never deployed. */
export async function uploadSecretCopy(api, worker, live, {changes, marker}) {
  const {parts, entry} = await api.workerContent(worker, live.versionId);
  const bindings = live.version?.resources?.bindings;
  assert(Array.isArray(bindings), 'invalid-active-version');
  const named = new Set(changes.map(change => change.binding));
  const metadata = {main_module:entry, ...liveSettings(live),
    bindings:[...bindings.filter(row => !named.has(row.name)).map(row => ({type:'inherit',name:row.name})),
      ...changes.flatMap(change => change.value !== undefined ? [{type:'secret_text',name:change.binding,text:change.value}]
        : change.publicDefault !== undefined ? [{type:'plain_text',name:change.binding,text:change.publicDefault}] : [])],
    keep_assets:true, annotations:{'workers/message':copyMessage(marker)}};
  const data = new FormData();
  data.set('metadata', new Blob([JSON.stringify(metadata)], {type:'application/json'}));
  for (const [name, file] of parts) data.set(name, file, name);
  const version = await api.request(`/workers/scripts/${worker}/versions?bindings_inherit=strict`, {method:'POST', body:data});
  assert(uuid(version?.id), 'invalid-secret-copy');
  const copy = await api.request(`/workers/scripts/${worker}/versions/${version.id}`);
  if (copy?.id !== version.id || !keepsLive(copy, live.version, named))
    throw Object.assign(new Error('secret-copy-settings-changed'), {drift:settingsDrift(copy, live.version), pendingChange:{bindings:[...named], present:changes[0].value !== undefined}});
  return version.id;
}

/** Send all traffic to the copy. */
export const deploySecretCopy = (api, worker, versionId) => api.request(`/workers/scripts/${worker}/deployments`, {method:'POST', body:{strategy:'percentage', versions:[{version_id:versionId, percentage:100}]}});

/** The newest version is this change's copy, uploaded right after the receipt's version and not
 * deployed: its id, and whether it runs what the live (receipt) version runs. A copy that does
 * not (one an older rer uploaded without the live limits) is never deployed. */
export async function undeployedCopy(api, worker, {pendingSecret, receipt}, versions, live) {
  if (!pendingSecret.copy || versions[1]?.id !== receipt.provider.versionId || !uuid(versions[0]?.id)) return null;
  const copy = await api.request(`/workers/scripts/${worker}/versions/${versions[0].id}`);
  if (copy?.id !== versions[0].id || copy.annotations?.['workers/message'] !== copyMessage(pendingSecret.copy)) return null;
  return {id:copy.id, keeps:keepsLive(copy, live.version, new Set(pendingSecret.bindings))};
}
