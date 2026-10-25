import { platformTable, identifier } from '../portability/bookkeeping.mjs';

// Serializable exclusions prevent restored authority, but cannot validate job
// references or normalize saved state. Do not qualify container restores until
// the destination-owned built-in validator is supplied in the portability round.
export function assertContainerArchiveRestorable(manifest) {
  if (!manifest.tables.some(table => identifier(table.name).startsWith('rer_job_') && !platformTable(table.name))) return;
  const error = new Error('Container restore of durable jobs requires the destination-owned job archive validator, which is not available in this round. Keep the archive and source installation; upgrade to a release with the supported inactive job restore policy before restoring into a container.');
  error.code = 'durable_jobs_restore_validator_required';
  throw error;
}
