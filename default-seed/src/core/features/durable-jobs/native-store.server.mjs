import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readSettings } from '../../../../scripts/base-onboarding/adapter-settings.mjs';

export const nativeRefusal = code => Object.assign(new Error(code), { code });

export async function referenceConfiguration(root) {
  // The established settings reader enforces the private-file rules. Only these
  // two nonsecret settings leave this function; settings are never logged.
  const { values } = await readSettings(root, {});
  if (values.DURABLE_JOBS_REFERENCE !== 'true') return null;
  if (typeof values.RER_INSTALLATION_ID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(values.RER_INSTALLATION_ID)) throw nativeRefusal('job_installation_required');
  return { installationId: values.RER_INSTALLATION_ID };
}

/** Open only the already-installed canonical D1 database. Discovery neither
 * starts a runtime nor creates state, and ambiguous DB custody is refused. */
export async function withReferenceDatabase(root, { readOnly, signal }, run) {
  signal?.throwIfAborted();
  let directory = root;
  for (const part of ['.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject']) {
    directory = join(directory, part);
    const status = await lstat(directory).catch(error => { if (error.code === 'ENOENT') throw nativeRefusal('job_installation_unavailable'); throw error; });
    if (status.isSymbolicLink() || !status.isDirectory()) throw nativeRefusal('job_unsafe_state');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const candidates = [];
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.sqlite')) continue;
    const path = join(directory, file.name);
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      if (tables.has('oa_operators') && tables.has('reference_sales_tenants')) candidates.push(path);
    } finally { probe.close(); }
  }
  if (candidates.length !== 1) throw nativeRefusal(candidates.length ? 'job_ambiguous_database' : 'job_schema_required');
  signal?.throwIfAborted();
  const database = new DatabaseSync(candidates[0], { readOnly });
  database.exec('PRAGMA busy_timeout=3000');
  try { return await run(database); }
  finally { database.close(); }
}
