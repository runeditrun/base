import { hash, uuid, identifier } from '../deploy-kit/validation.mjs';

// Secret PUT drops the version message but retains code, runtime and bindings
// (secret values are not readable). Ignore only the upload tool's provenance;
// compare every other resource field, including assets and binding identities.
function identity(version) {
  const resources = version?.resources, script = resources?.script, bindings = resources?.bindings;
  if (typeof script?.etag !== 'string' || !script.etag || !resources.script_runtime?.compatibility_date
    || !Array.isArray(bindings) || !bindings.every(row => identifier(row?.name) && typeof row.type === 'string')
    || new Set(bindings.map(row => row.name)).size !== bindings.length) return null;
  const { last_deployed_from: provenance, ...content } = script;
  // The provider changes this from wrangler to api on a secret PUT.
  void provenance;
  return hash({ ...resources, script: content, bindings: [...bindings].sort((a, b) => a.name.localeCompare(b.name)) });
}

/** Read-only proof under this account and Worker name. Never jump over a foreign
 * version to find an older rer mark, or accept an undeployed/split successor. */
export async function secretRotationOwned(api, plan, served) {
  if (!served.current || served.annotation !== undefined) return false;
  const path = `/workers/scripts/${plan.worker}/versions`;
  const items = (await api.request(path))?.items;
  if (!Array.isArray(items) || items[0]?.id !== served.versionId || !items.every(row => uuid(row?.id))
    || new Set(items.map(row => row.id)).size !== items.length) return false;
  let expected;
  for (const { id } of items) {
    let version;
    try { version = await api.request(`${path}/${id}`); }
    catch (error) { if (error.status === 404) return false; throw error; }
    if (version?.id !== id) return false;
    const fingerprint = identity(version);
    if (!fingerprint || expected && fingerprint !== expected) return false;
    expected ??= fingerprint;
    const message = version.annotations?.['workers/message'];
    if (message !== undefined) return message === plan.record;
    if (version.annotations?.['workers/triggered_by'] !== 'secret') return false;
  }
  return false;
}
