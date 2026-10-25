import { setTimeout as delay } from 'node:timers/promises';
import { redact } from './errors.mjs';

export function originUrl(value = 'https://app.runeditrun.com') {
 let url;
 try { url = new URL(value); } catch { throw Error('Business origin must be an HTTPS origin.'); }
 const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
 if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw Error('Business origin must be an HTTPS origin (HTTP is allowed only on loopback).');
 }
 return url.origin;
}

// The server's own reason travels with its status: platform errors answer
// {error: message, code, requestId}, older ones {error: code}. The message is
// shown as one bounded line of text, never as markup; callers match the code.
export class ApiError extends Error {
 constructor(status, reason = null, requestId = null, code = null) {
  const said = reason ? ` The server said: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}` : '';
  const reference = requestId ? ` Reference ${requestId}.` : '';
  super((status === 401 ? 'Business pairing was revoked or expired. Reconnect in your browser.' : `Business server refused the request (HTTP ${status}).`) + said + reference);
  this.status = status; this.reason = reason; this.requestId = requestId; this.code = code;
 }
}

async function refusal(response, signal) {
 let text = '';
 try { text = (await readBody(response, signal, 4096)).text; } catch { /* The status alone is the reason. */ }
 let body = null;
 try { body = JSON.parse(text); } catch { /* A plain-text reason is used as it is. */ }
 const line = value => typeof value === 'string' && value.trim() ? redact(value).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
 const closed = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : null;
 const reason = body && typeof body === 'object' ? line(body.error) ?? line(body.message) : /^\s*</.test(text) ? null : line(text);
 const requestId = body && typeof body === 'object' && typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(body.requestId) ? body.requestId : null;
 return new ApiError(response.status, reason, requestId, body && typeof body === 'object' ? closed(body.code) ?? closed(body.error) : null);
}

// Fetch links its abort signal to a response body only weakly: once the
// request object is collected, an abort no longer reaches a stalled body. The
// body is read through a reader that the caller's signal cancels directly.
export async function readBody(response, signal, limit) {
 if (!response.body) return { text: '', over: false };
 const reader = response.body.getReader(), cancel = () => { reader.cancel(signal.reason).catch(() => {}); };
 if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
 try {
  const chunks = []; let size = 0;
  for (;;) {
   const { done, value } = await reader.read();
   signal.throwIfAborted();
   if (done) return { text: new TextDecoder().decode(Buffer.concat(chunks)), over: false };
   chunks.push(value); size += value.byteLength;
   if (size > limit) { cancel(); return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit)), over: true }; }
  }
 } finally { signal.removeEventListener('abort', cancel); }
}

const network = {
 ECONNREFUSED: 'the connection was refused; check that the server is running',
 ENOTFOUND: 'its name did not resolve; network access may be off in this session',
 EAI_AGAIN: 'its name did not resolve; network access may be off in this session',
 EPERM: 'the network was blocked (Operation not permitted); allow network access for this session',
 EACCES: 'the network was blocked (permission denied); allow network access for this session',
 ECONNRESET: 'the connection was reset',
 ETIMEDOUT: 'the connection timed out',
 EHOSTUNREACH: 'the host is unreachable',
 ENETUNREACH: 'the network is unreachable',
};
function unreachable(origin, error) {
 const code = error?.cause?.code ?? error?.code;
 const cause = error?.name === 'TimeoutError' ? 'it did not answer within 30 seconds'
  : network[code] ?? (code ? `the request failed (${code})` : `the request failed (${error?.cause?.message ?? error?.message ?? 'no reason given'})`);
 return Error(`Could not reach the Business server at ${origin}: ${redact(cause)}.`);
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
  return this.request('POST', path, body, { token, signal, timeout, headers });
 }
 async get(path) { return this.request('GET', path); }
 async delete(path) { return this.request('DELETE', path); }
 async request(method, path, body, { token = this.credential, signal, timeout = 30_000, headers = {} } = {}) {
  if (!path.startsWith('/api/business/') || path.includes('..') || path.includes('?') || path.includes('#')) throw Error('Invalid Business route.');
  // One deadline covers the headers and the whole body. This request holds its
  // controller and timer until it ends, and the caller's signal joins it.
  const deadline = new AbortController(), follow = () => deadline.abort(signal.reason);
  const timer = setTimeout(() => deadline.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeout);
  if (signal?.aborted) follow(); else signal?.addEventListener('abort', follow, { once: true });
  const unanswered = error => signal?.aborted ? signal.reason : unreachable(this.origin, error);
  try {
   let response;
   try {
    response = await fetch(this.origin + path, {
     method, redirect: 'error',
     headers: { ...headers, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
     ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: deadline.signal,
    });
   } catch (error) { throw unanswered(error); }
   if (!response.ok) throw await refusal(response, deadline.signal);
   // Successful bodies are untrusted: callers validate them and print only fields they template.
   if (response.status === 202 && response.headers.get('content-length') === '0' || response.status === 204) return null;
   let read;
   try { read = await readBody(response, deadline.signal, 2_000_000); } catch (error) { throw unanswered(error); }
   if (read.over) throw Error('Business response exceeded the limit.');
   if (!read.text) return null;
   let result;
   try { result = JSON.parse(read.text); } catch { throw Error('Business server returned an invalid response.'); }
   return result && Object.hasOwn(result, 'data') ? result.data : result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', follow); }
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
