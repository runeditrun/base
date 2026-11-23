import { combinedSignal, pause } from './cancellation.mjs';
import { checkResourceIdentity, refuse } from './owner.mjs';
import { r2ObjectPages } from './r2-objects.mjs';
import { assert, resourceName, uuid } from './validation.mjs';

const activeStatuses = ['ENQUEUED', 'RUNNING'];
const jobStatuses = new Set([...activeStatuses, 'COMPLETED', 'FAILED', 'CANCELLED']);

export async function checkBucket(api, name, entry, signal) {
  const row = await api.request(`/r2/buckets/${name}`, {signal});
  if (row?.name !== name) throw refuse('owned-resource-replaced', 'r2', name);
  checkResourceIdentity('r2', name, row, entry);
}

export function requireBucketIdentity(name, entry) {
  assert(resourceName(name), 'invalid-r2-bucket-name');
  if (entry?.status !== 'created' || typeof entry.id !== 'string' || !entry.id) throw refuse('uncertain-resource-create', 'r2', name);
}

function prefixJob(job) {
  assert(uuid(job?.id) && job.jobType === 'prefixDelete' && typeof job.prefixDelete?.prefix === 'string' && jobStatuses.has(job.status), 'invalid-r2-purge-job');
  return job;
}

function clearJob(job, id = job?.id) {
  assert(prefixJob(job).id === id && job.prefixDelete.prefix === '' && job.prefixDelete.isBucketClear !== false, 'invalid-r2-purge-job');
  return job;
}

async function activeClearJob(api, path, signal) {
  // Read ENQUEUED first to allow a job to move to RUNNING between lists.
  for (const status of activeStatuses) {
    const seen = new Set();
    const query = new URLSearchParams({jobType:'prefixDelete',status,maxKeys:'1000'});
    for (;;) {
      const result = await api.request(`${path}?${query}`, {signal});
      assert(Array.isArray(result?.jobs) && result.jobs.length <= 1000, 'invalid-r2-purge-job-list');
      const job = result.jobs.map(prefixJob).find(item => item.prefixDelete.prefix === '' && activeStatuses.includes(item.status));
      if (job) return clearJob(job);
      const next = result.nextContinuationToken;
      if (next == null || next === '') break;
      assert(typeof next === 'string' && next.length <= 4096 && /^[a-zA-Z0-9_+\/=-]+$/.test(next) && !seen.has(next) && seen.size < 100, 'invalid-r2-purge-job-page');
      query.set('continuationToken', next);
      seen.add(next);
    }
  }
}

async function hasObjects(api, name, signal) {
  for await (const rows of r2ObjectPages(api, name, {signal})) if (rows.length) return true;
  return false;
}

async function waitForClearJob(api, path, job, signal) {
  const id = job.id;
  for (let delay = 500; activeStatuses.includes(job.status); delay = Math.min(delay * 2, 4000)) {
    await pause(delay, signal);
    job = clearJob(await api.request(`${path}/${id}`, {signal}), id);
  }
  if (job.status !== 'COMPLETED') {
    const error = new Error('r2-purge-job-unsuccessful');
    error.providerCall = {operation:`GET ${path}/${id}`,reason:`Cloudflare reported the bucket purge as ${job.status}`};
    throw error;
  }
}

// Cloudflare can finish small jobs synchronously or continue after a CLI exits.
// Discover a surviving full-bucket job before submitting a new one. The caller
// must hold the ownership lock and independently read back bucket absence.
export async function removeOwnedBucket(api, {name, entry}, {signal, purgeMs = 600000} = {}) {
  requireBucketIdentity(name, entry);
  const deadline = AbortSignal.timeout(purgeMs);
  const bounded = combinedSignal(signal, deadline);
  const bucket = `/r2/buckets/${name}`, jobs = `${bucket}/jobs`;
  const beforeRetry = retrySignal => checkBucket(api, name, entry, retrySignal);
  try {
    await checkBucket(api, name, entry, bounded);
    if (await hasObjects(api, name, bounded)) {
      let job = await activeClearJob(api, jobs, bounded);
      if (!job) {
        // Cloudflare does not offer a conditional write based on creation date.
        // Outside deletion/recreation of this bucket must be serialized.
        await checkBucket(api, name, entry, bounded);
        job = clearJob(await api.request(jobs, {method:'POST',body:{jobType:'prefixDelete',prefix:''},signal:bounded,beforeRetry}));
      }
      await waitForClearJob(api, jobs, job, bounded);
    }
    await checkBucket(api, name, entry, bounded);
    await api.request(bucket, {method:'DELETE',signal:bounded,beforeRetry});
  } catch (error) {
    if (!signal?.aborted && deadline.aborted) throw Object.assign(new Error('r2-purge-timeout'), {cause:error});
    throw error;
  }
}
