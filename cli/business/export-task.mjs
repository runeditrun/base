import { withUploadedBundle, door, checkedPreview, plural } from './vendor-door.mjs';

/** Perform a claimed export.vendor: the shipped adapter's bundle uploaded into
 * the app's import door, then the door's plan (a zero-write preview), then
 * completion with the door's upload_id and plan_id and the bundle's SHA-256.
 * Returns the line to say. */
export function runExport({ lease, task, grant, directory, say, ownerPage }) {
 return withUploadedBundle({ lease, task, grant, directory, say,
  doing: (name, origin, keyed) => `Exporting ${name} through the shipped read-only adapter. ${keyed ? 'The key stays on this computer; records' : 'Records'} go only to the app's import door at ${origin}.` },
 async ({ origin, uploadId, bundle, fresh }) => {
  const preview = await door(await fresh('plan'), { uploadId }, lease.signal), { records, created, updated, unchanged, rejected } = checkedPreview(preview, bundle);
  // Identifiers only: Business reads that plan from the door with its own grants
  // and completes the task only if it is the plan of exactly this bundle.
  return { outputs: { upload_id: uploadId, plan_id: preview.planId, bundle_sha256: bundle.sha256 },
   said: `Import preview ready in ${origin}: ${plural(records, 'source record')}; ${created} to create, ${updated} to update, ${unchanged} unchanged, ${rejected} rejected. Nothing was imported: the owner reviews and approves this move in the browser: ${ownerPage}` };
 });
}
