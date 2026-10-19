import { rmSync } from 'node:fs';

// Finder and other filesystem observers can add metadata while removal walks
// the directory. Retry those races, but never turn finished artifacts into a
// failed release merely because temporary files could not be removed.
export function cleanupTemporary(directory) {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return null;
  } catch (error) {
    const warning = { code: 'temporary-cleanup-failed', errorCode: error.code ?? 'UNKNOWN',
      directory, message: 'Temporary release cleanup failed; remove the remaining directory manually.' };
    console.warn(`Warning: ${warning.message} (${warning.errorCode}): ${directory}`);
    return warning;
  }
}
