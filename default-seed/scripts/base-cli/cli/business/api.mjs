import { setTimeout as delay } from 'node:timers/promises';

export function originUrl(value = 'https://app.runeditrun.com') {
 let url;
 try { url = new URL(value); } catch { throw Error('Business origin must be an HTTPS origin.'); }
 const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
 if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw Error('Business origin must be an HTTPS origin (HTTP is allowed only on loopback).');
 }
 return url.origin;
}

export class ApiError extends Error {
 constructor(status) {
  super(status === 401 ? 'Business pairing was revoked or expired. Reconnect in your browser.' : `Business server refused the request (HTTP ${status}).`);
  this.status = status;
 }
}

export class Api {
 constructor(origin, credential) { this.origin = originUrl(origin); this.credential = credential; }
 async mintToken(audience, { taskId, signal } = {}) {
  const result = await this.post('/api/business/executors/token', { audience, ...(taskId ? { task_id: identifier(taskId) } : {}) }, { signal });
  const maximum = audience === 'mcp' ? 300 : 900;
  if (typeof result?.access_token !== 'string' || !result.access_token.startsWith('bz_task_') || result.token_type !== 'Bearer'
   || result.audience !== `${this.origin}/api/business/${audience}` || result.task_id !== (taskId ?? null)
   || !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > maximum
   || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) throw Error('Business server returned an invalid scoped bearer.');
  return result;
 }
 async post(path, body, { token = this.credential, signal, timeout = 30_000, headers = {} } = {}) {
  if (!path.startsWith('/api/business/') || path.includes('..') || path.includes('?') || path.includes('#')) throw Error('Invalid Business route.');
  let response;
  try {
   response = await fetch(this.origin + path, {
    method: 'POST', redirect: 'error',
    headers: { ...headers, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
   });
  } catch (error) { if (signal?.aborted) throw signal.reason; throw Error('Could not reach the Business server.'); }
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status); }
  // Never print server errors or evidence; even successful bodies are untrusted.
  if (response.status === 202 && response.headers.get('content-length') === '0' || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  if (text.length > 2_000_000) throw Error('Business response exceeded the limit.');
  let result;
  try { result = JSON.parse(text); } catch { throw Error('Business server returned an invalid response.'); }
  return result && Object.hasOwn(result, 'data') ? result.data : result;
 }
}

export async function pause(milliseconds, signal) {
 await delay(milliseconds, undefined, { signal });
}

export function identifier(value) {
 if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,399}$/.test(value)) throw Error('Business server returned an invalid identifier.');
 return value;
}
export const taskPath = (id, action) => `/api/business/tasks/${encodeURIComponent(identifier(id))}/${action}`;
