import { resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { cookieFile } from '../modules/portability/cli-options.mjs';
import { isLoopbackHost } from '../modules/operator-auth/loopback.mjs';
import { heldDeployments } from './deployment-record.mjs';
import { invalid, missing, RerError } from './errors.mjs';

export function jobsOrigin(value) {
 let url;
 try { url = new URL(value); } catch { throw invalid('Provide a valid jobs origin.'); }
 if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && isLoopbackHost(url.hostname))) throw invalid('Jobs inspection requires a credential-free HTTPS origin, or a loopback HTTP origin, without a path.');
 return url.origin;
}

export function jobsTenant(value) {
 if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value))) throw invalid('--tenant requires a tenant ID of 1–100 letters, digits, underscores, dots, colons or hyphens, starting with a letter or digit.');
 return value;
}

export async function hostedJobs(project, options, signal) {
 let origin = options.origin;
 if (origin === undefined) {
  const held = await heldDeployments(project.root), environment = options.environment ?? 'production';
  origin = held.find(item => item.environment === environment)?.record.receipt?.origin;
  if (!origin) throw missing('No hosted origin is recorded for this deployment. Supply --origin with the installation address.');
 }
 origin = jobsOrigin(origin);
 let cookie;
 try {
  const path = resolve(project.root, options.sessionFile), info = await lstat(path);
  if (info.nlink !== 1 || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw Error();
  cookie = await cookieFile(path);
 } catch { throw invalid('The session file must be an owned private regular file (0600) containing one session cookie.'); }
 return readJobsHttp({ origin, cookie, tenant: options.tenant, action: options.jobsAction, id: options.jobId, signal });
}

// Shared by hosted inspection and an installation's declared native adapter.
// The caller supplies authenticated transport; this helper never signs in,
// starts a server, executes jobs, or follows a credential-bearing redirect.
export async function readJobsHttp({ origin, cookie, tenant, action, id, signal, request = fetch }) {
 origin = jobsOrigin(origin);
 tenant = jobsTenant(tenant);
 const path = action === 'status' ? '/status' : '/' + encodeURIComponent(id);
 let response;
 try {
  response = await request(origin + '/api/rer/jobs' + path, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean)), headers: { Accept: 'application/json', Origin: origin, Cookie: cookie, ...(tenant === undefined ? {} : { 'x-rer-sales-tenant': tenant }) } });
 } catch { throw new RerError('jobs_unavailable', 'The jobs inspection door did not answer. Check that the selected installation is running.', 3); }
 let body;
 try { body = await boundedJson(response); } catch { if (response.ok) throw new RerError('invalid_jobs_response', `Jobs inspection returned invalid or oversized JSON (HTTP ${response.status}).`, 1); }
 const credential = cookie.slice(cookie.indexOf('=') + 1);
 if (body !== undefined && [cookie, credential].filter(Boolean).some(secret => JSON.stringify(body).includes(secret))) throw new RerError('invalid_jobs_response', 'Jobs inspection returned credential-bearing data.', 1);
 if (!response.ok) {
  const raw = body?.code ?? body?.error?.code ?? body?.error;
  const code = typeof raw === 'string' && /^(?:job_[a-z_]{1,64}|scheduler_unconfigured|unauthorized|forbidden|not_found)$/.test(raw) ? raw : 'jobs_request_failed';
  throw new RerError(code, `Jobs inspection refused (HTTP ${response.status}; ${code}).`, response.status === 401 || response.status === 403 ? 4 : response.status === 404 ? 3 : 1);
 }
 return body;
}

async function boundedJson(response) {
 const reader = response.body?.getReader();
 if (!reader) throw Error();
 const chunks = []; let size = 0;
 try {
  for (;;) {
   const { value, done } = await reader.read();
   if (done) break;
   size += value.byteLength;
   if (size > 1024 * 1024) throw Error();
   chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
 } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
