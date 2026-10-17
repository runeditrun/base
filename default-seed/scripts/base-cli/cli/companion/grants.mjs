/**
 * A local execution grant is issued by the management service for one job,
 * device, provider, and request.  The companion never creates or broadens a
 * grant; it only validates the signed-by-storage scope that arrived with the
 * claimed job and echoes its id on relay writes.
 */
export function executionGrant(job, state) {
  const value = job?.execution_grant;
  if (value === undefined || value === null) throw new Error('Claimed local job is missing its scoped execution grant. Reconcile with the management service.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scoped local execution grant.');
  const strings = ['id', 'installationId', 'deviceId', 'userId', 'jobId', 'requestId', 'projectId', 'issuedAt'];
  if (strings.some(key => typeof value[key] !== 'string' || value[key].length === 0)) throw new Error('Invalid scoped local execution grant.');
  if (!['codex', 'claude'].includes(value.provider) || value.executor !== 'local') throw new Error('Invalid scoped local execution grant provider.');
  if (value.managementReservationId !== null && typeof value.managementReservationId !== 'string') throw new Error('Invalid local management reservation binding.');
  if (value.runId !== job.run_id) throw new Error('Scoped local execution grant run differs from the claimed run.');
  if (value.jobId !== job.id || value.requestId !== job.request_id || value.projectId !== job.project_id || value.deviceId !== job.device_id || value.installationId !== job.installation_id) {
    throw new Error('Scoped local execution grant does not match this job.');
  }
  if (state?.provider && value.provider !== state.provider) throw new Error('Scoped local execution grant provider differs from the paired provider.');
  if (state?.device?.id && value.deviceId !== state.device.id) throw new Error('Scoped local execution grant device differs from the paired device.');
  return value;
}

export function grantId(job, state) {
  return executionGrant(job, state)?.id ?? null;
}

export function safeGrantId(job, state) {
  try { return grantId(job, state); } catch { return null; }
}
