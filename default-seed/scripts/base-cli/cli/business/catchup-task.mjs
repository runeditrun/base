import { withUploadedBundle, door, checkedPreview, plural } from './vendor-door.mjs';

// Why the door refused a catch-up under the owner's standing approval
// (import-kit door, "Catch-up and recovery": `catchup_requires_proposal:<reason>`).
const beyond = {
 empty_baseline: 'the app holds no earlier import to compare with',
 source_records_gone: 'records were removed in the old tool',
 native_or_mapping_conflict: 'records changed in the app since they were imported',
 rejected_or_unmapped_records: 'some records cannot be brought over as they are',
 change_must_be_under_five_percent: '5% or more of the records changed',
};

/**
 * Perform a claimed catchup.vendor: the vendor's current export uploaded into the
 * app's import door, then a catch-up plan of it (a zero-write preview of what
 * changed since the import). Business mints the plan grant under the owner's
 * standing catch-up approval when one covers this tool; the door then refuses a
 * change at or above its bound, and run asks for a plan grant for the owner's
 * review instead. Completion reports the door's upload_id and plan_id and the
 * bundle's SHA-256; Business applies the plan under the standing approval or
 * after the owner approves it. Returns the line to say.
 */
export function runCatchup({ lease, task, grant, directory, say, ownerPage }) {
 return withUploadedBundle({ lease, task, grant, directory, say,
  doing: (name, origin) => `Bringing over recent ${name} changes through the shipped read-only adapter. The key stays on this computer; records go only to the app's import door at ${origin}.` },
 async ({ origin, uploadId, bundle, fresh }) => {
  let planGrant = await fresh('plan'), refused = null, preview;
  try { preview = await door(planGrant, { uploadId, catchup: true }, lease.signal); }
  catch (error) {
   const reason = planGrant.catchup === 'bounded' && /^catchup_requires_proposal:([a-z0-9_]+)$/.exec(error.doorCode ?? '')?.[1];
   if (!reason) throw error;
   refused = Object.hasOwn(beyond, reason) ? beyond[reason] : 'it is more than that approval covers';
   planGrant = await fresh('plan', { review: true });
   preview = await door(planGrant, { uploadId, catchup: true }, lease.signal);
  }
  const { records, created, updated, unchanged, gone, rejected } = checkedPreview(preview, bundle);
  const planned = `Catch-up planned in ${origin}: ${plural(records, 'source record')}; ${created} new, ${updated} changed, ${unchanged} unchanged, ${gone} gone, ${rejected} rejected.`;
  return { outputs: { upload_id: uploadId, plan_id: preview.planId, bundle_sha256: bundle.sha256 },
   said: planGrant.catchup === 'bounded' ? `${planned} It is within the owner's standing catch-up approval, so Business applies it and checks the result.`
    : `${planned} ${refused ? `It needs the owner's own approval (${refused}): nothing` : 'Nothing'} changes in the app until the owner approves this catch-up in the browser: ${ownerPage}` };
 });
}
