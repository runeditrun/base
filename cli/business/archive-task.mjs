import { withUploadedBundle, door, DOOR_ID, count, plural } from './vendor-door.mjs';

// Key order is not part of the door's counts; compare them as values.
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/**
 * Perform a claimed switchoff.archive: the vendor's final export uploaded into
 * the app's import door, kept there by the door's `archive` action as the tool's
 * archive in the app's own storage (`business-archive/<tool>/<takenAt>`, the tool
 * being the vendor's namespace), then read back by the door's `restore-check`,
 * which parses it and writes nothing native. Run checks that the archive and its
 * test-restore are exactly this bundle, then completes with the archive_id and
 * the bundle's SHA-256; Business runs its own restore-check before the task is
 * done. Returns the line to say.
 */
export function runArchive({ lease, task, grant, directory, say, ownerPage }) {
 const takenAt = new Date().toISOString();
 return withUploadedBundle({ lease, task, grant, directory, say,
  doing: (name, origin, keyed) => `Archiving the final ${name} export through the shipped read-only adapter. ${keyed ? 'The key stays on this computer; the archive' : 'The archive'} goes only to the app's import door at ${origin} and stays in the app's own storage.` },
 async ({ vendor, name, origin, uploadId, bundle, fresh }) => {
  const kept = await door(await fresh('archive'), { uploadId, tool: vendor, takenAt }, lease.signal);
  const [input, unique, rejected] = ['input', 'unique', 'rejected'].map(field => count(kept.counts?.[field]));
  if (typeof kept.archiveId !== 'string' || !DOOR_ID.test(kept.archiveId) || kept.key !== `business-archive/${vendor}/${takenAt}` || kept.tool !== vendor
   || kept.takenAt !== takenAt || kept.bundleSha256 !== bundle.sha256 || kept.bytes !== bundle.size || [input, unique, rejected].includes(null)) throw Error("The app's import door returned an invalid archive answer.");
  // The door reads its own copy back and parses it as a restore would, with no native writes.
  const restored = await door(await fresh('restore-check'), { archiveId: kept.archiveId }, lease.signal);
  if (restored.archiveId !== kept.archiveId || restored.key !== kept.key || restored.bundleSha256 !== bundle.sha256 || restored.bytes !== bundle.size
   || stable(restored.counts) !== stable(kept.counts) || !Array.isArray(restored.rejected)) throw Error(`The app's test-restore of the ${name} archive does not match the exported file. The archive was not reported.`);
  return { outputs: { archive_id: kept.archiveId, bundle_sha256: bundle.sha256 },
   said: `Archive kept in ${origin} as ${kept.key}: ${plural(bundle.size, 'byte')}, ${plural(unique, 'source record')}, test-restored with no writes (${rejected} rejected). Business test-restores it again itself; cancelling ${name} stays the owner's step in the browser: ${ownerPage}` };
 });
}
