import { missing, RerError } from './errors.mjs';
import { hostedJobs } from './jobs-http.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Native hooks resolve the installation's current principal and return the
// same redacted v1 envelope as HTTP. No client SQL or execution hook exists.
export async function jobsCommand(project, options, signal) {
 let result;
 if (options.origin !== undefined || options.target === 'remote') result = await hostedJobs(project, options, signal);
 else {
  const read = project.adapter?.jobs?.[options.jobsAction];
  if (typeof read !== 'function') throw missing('This installation has no declared native jobs inspection adapter. Use a hosted --origin with --session-file, or adopt the durable jobs adapter.');
  try { result = await read({ root: project.root, signal, ...(options.jobId === undefined ? {} : { id: options.jobId }) }); }
  catch (error) {
   if (error instanceof RerError) throw error;
   const code = typeof error?.code === 'string' && /^(?:job_[a-z_]{1,64}|scheduler_unconfigured)$/.test(error.code) ? error.code : 'jobs_unavailable';
   throw new RerError(code, `Native jobs inspection failed (${code}). Check the declared jobs adapter and installation runtime.`, 3);
  }
 }
 const field = options.jobsAction === 'status' ? 'status' : 'job';
 if (!object(result) || result.schemaVersion !== 1 || !object(result[field])) throw new RerError('invalid_jobs_response', 'Jobs inspection requires a schemaVersion 1 response with the requested status or job.', 1);
 return result;
}

export async function jobsDiagnostics(project, signal) {
 if (typeof project.adapter?.jobs?.diagnostics !== 'function') return undefined;
 try {
  const result = await project.adapter.jobs.diagnostics({ root: project.root, signal });
  if (!object(result)) throw Error();
  return result;
 } catch {
  return { ok: false, code: 'jobs_diagnostics_unavailable' };
 }
}
