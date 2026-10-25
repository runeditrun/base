import { insist, JobError, text } from './codec.ts';
import { safeJob } from './read.ts';
import type { DurableJobs } from '../index.ts';
import type { Authority, Intent, Mutation } from './types.ts';

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
/** Authentication is destination-owned: native sessions require its existing origin/CSRF admission. */
export function createJobHandler(jobs: DurableJobs, authenticate: (request: Request, mutation: boolean) => Promise<Authority | null>, options: { maxBodyBytes?: number } = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 65536;
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), path = url.pathname.replace(/\/$/, '');
      if (!/^\/api\/rer\/jobs(?:\/|$)/.test(path)) return new Response(null, { status: 404, headers });
      insist(['GET', 'POST'].includes(request.method), 'job_method_refused', 405);
      const authority = await authenticate(request, request.method === 'POST');
      insist(authority, 'job_authentication_required', 401);
      let body: Record<string, unknown> = {};
      if (request.method === 'POST') {
        insist(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'job_json_required', 415);
        const reader = request.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
        if (reader) {
          try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; insist(bytes <= maxBodyBytes, 'job_payload_too_large', 413); chunks.push(next.value); } }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw new JobError('job_invalid_json', 400); }
        insist(body && typeof body === 'object' && !Array.isArray(body), 'job_invalid_json');
      }
      const base = '/api/rer/jobs';
      if (request.method === 'GET' && (path === base + '/status' || path === base + '/diagnostics')) return Response.json(await jobs.status(authority), { headers });
      if (path === base && request.method === 'GET') {
        insist([...url.searchParams.keys()].every(key => ['kind','state','cursor','limit'].includes(key)), 'job_invalid_filter');
        return Response.json({ schemaVersion: 1, ...await jobs.list({ kind: url.searchParams.get('kind') ?? undefined, state: url.searchParams.get('state') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined }, authority) }, { headers });
      }
      if (path === base && request.method === 'POST') {
        insist(Object.keys(body).every(key => ['kind','operationKey','requestedRevision','inputRef','notBefore','deadline'].includes(key)), 'job_invalid_intent');
        const response = await jobs.request(body as unknown as Intent, authority);
        return Response.json({ schemaVersion: 1, job: safeJob(response.job) }, { status: response.created ? 202 : 200, headers });
      }
      const match = path.slice(base.length).match(/^\/([^/]+)(?:\/(cancel|resume|undo))?$/);
      insist(match, 'job_not_found', 404);
      const id = decodeURIComponent(match[1]);
      if (request.method === 'GET' && !match[2]) return Response.json({ schemaVersion: 1, job: safeJob(await jobs.get(id, authority)) }, { headers });
      insist(request.method === 'POST' && match[2], 'job_not_found', 404);
      insist(Object.keys(body).every(key => ['expectedVersion','operationKey','reason'].includes(key)), 'job_invalid_mutation');
      text(body.operationKey, 'operation_key');
      if (match[2] === 'undo') {
        // Unsupported compensation is still an authenticated, version-bound mutation door.
        const job = await jobs.get(id, authority);
        insist(body.expectedVersion === job.version && typeof body.operationKey === 'string', 'job_version_conflict');
        await jobs.requestUndo(id, authority);
      }
      const job = await jobs[match[2] as 'cancel' | 'resume'](id, body as unknown as Mutation, authority);
      return Response.json({ schemaVersion: 1, job: safeJob(job) }, { headers });
    } catch (error) {
      const known = error instanceof JobError;
      return Response.json({ error: { code: known ? error.code : 'job_unavailable', recovery: known ? error.recovery : 'Inspect installation storage and registered job configuration.' } }, { status: known ? error.status : 503, headers: { ...headers, ...(known && error.status === 429 ? { 'retry-after': '5' } : {}) } });
    }
  };
}
