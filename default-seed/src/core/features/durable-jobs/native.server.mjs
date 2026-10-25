import { nativeRefusal, referenceConfiguration, withReferenceDatabase } from './native-store.server.mjs';

async function runtime(root, signal, readOnly, run) {
  const configuration = await referenceConfiguration(root);
  if (!configuration) throw nativeRefusal('job_reference_not_configured');
  return withReferenceDatabase(root, { readOnly, signal }, async sqlite => {
    const { nativeDatabase } = await import('../../../../../modules/durable-jobs/native.mjs');
    const { createReferenceSalesJobs } = await import('./runtime.server.ts');
    const { safeJob } = await import('../../../../../modules/durable-jobs/index.ts');
    const database = nativeDatabase(sqlite);
    const jobs = createReferenceSalesJobs({ database, ...configuration, scheduler: 'native' });
    return run({ sqlite, database, jobs, safeJob, ...configuration });
  });
}

async function ownerAuthority(database, installationId, tenantId) {
  const { referenceSalesAuthority } = await import('./authority.server.ts');
  const owners = await database.all({ sql: `SELECT o.id FROM oa_operators o JOIN reference_sales_tenants t ON t.owner_id=o.id
    WHERE o.role='owner' AND o.status='active' AND t.installation_id=? AND t.tenant_key=? AND t.active=1`, params: [installationId, tenantId ?? ''] });
  if (owners.length !== 1) throw nativeRefusal('job_not_found');
  const authority = await referenceSalesAuthority(database, installationId, owners[0].id, tenantId);
  if (!authority) throw nativeRefusal('job_not_found');
  return authority;
}

/** Local RER custody has DB access already; this adapter resolves the current
 * installation owner in that DB instead of accepting CLI-supplied ownership. */
export const nativeReferenceJobs = {
  async status({ root, signal }) {
    return runtime(root, signal, true, async ({ database, jobs, installationId }) => {
      const tenants = await database.all({ sql: `SELECT t.tenant_key FROM reference_sales_tenants t
        JOIN oa_operators o ON o.id=t.owner_id AND o.status='active' AND o.role='owner'
        JOIN reference_sales_memberships m ON m.installation_id=t.installation_id AND m.tenant_key=t.tenant_key AND m.principal_id=o.id AND m.active=1
        WHERE t.installation_id=? AND t.active=1 ORDER BY t.tenant_key LIMIT 101`, params: [installationId] });
      if (tenants.length > 100) throw nativeRefusal('job_scope_limit');
      const scopes = [];
      for (const tenant of tenants) {
        const authority = await ownerAuthority(database, installationId, tenant.tenant_key || null);
        scopes.push({ tenantId: authority.tenantId, ...(await jobs.status(authority)).status });
      }
      if (!tenants.length) throw nativeRefusal('job_not_found');
      return { schemaVersion: 1, status: { installationId, scopes } };
    });
  },
  async inspect({ root, id, signal }) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw nativeRefusal('job_not_found');
    return runtime(root, signal, true, async ({ database, jobs, safeJob, installationId }) => {
      const [job] = await database.all({ sql: 'SELECT tenant_key FROM rer_job_jobs WHERE installation_id=? AND id=?', params: [installationId, id] });
      if (!job) throw nativeRefusal('job_not_found');
      const authority = await ownerAuthority(database, installationId, job.tenant_key || null);
      return { schemaVersion: 1, job: safeJob(await jobs.get(id, authority)) };
    });
  },
  async diagnostics({ root, signal }) {
    const configuration = await referenceConfiguration(root);
    if (!configuration) return { configured: false, code: 'job_reference_not_configured' };
    return runtime(root, signal, true, async ({ jobs, database, installationId }) => {
      const [tenant] = await database.all({ sql: 'SELECT tenant_key FROM reference_sales_tenants WHERE installation_id=? AND active=1 ORDER BY tenant_key LIMIT 1', params: [installationId] });
      if (!tenant) return { configured: true, code: 'job_authority_unavailable' };
      const authority = await ownerAuthority(database, installationId, tenant.tenant_key || null);
      return { configured: true, ...(await jobs.status(authority)) };
    });
  },
  async lifecycle({ root, phase, custody, signal }) {
    if (!await referenceConfiguration(root)) return;
    if (!Number.isInteger(custody?.pid) || typeof custody.start !== 'string' || !custody.start) throw nativeRefusal('job_holder_required');
    const holder = `${custody.pid}:${custody.start}`;
    return runtime(root, signal, false, async ({ database, jobs, installationId }) => {
      if (phase === 'stop') return jobs.quiesce({ holder });
      if (phase !== 'start') throw nativeRefusal('job_lifecycle_invalid');
      const [control] = await database.all({ sql: 'SELECT holder FROM rer_job_control WHERE installation_id=?', params: [installationId] });
      let replaceHolder;
      if (control?.holder && control.holder !== holder) {
        const match = /^(\d+):(.+)$/s.exec(control.holder);
        if (!match) throw nativeRefusal('job_runner_custody_unknown');
        const { processInfo } = await import('../../../../../modules/job-queue/processes.mjs');
        const previous = await processInfo(Number(match[1]));
        if (previous && !previous.zombie && previous.start === match[2]) throw nativeRefusal('job_runner_active');
        replaceHolder = control.holder;
      }
      await jobs.start({ holder, ...(replaceHolder ? { replaceHolder } : {}) });
      // Resume one proven-safe persisted unit at startup; later work is woken
      // by the installation's declared cron, within the same process custody.
      return jobs.tick({ maxJobs: 1, holder });
    });
  },
};
