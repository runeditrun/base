import { PortabilityError } from './storage.mjs';

// Public errors use the existing {error:code} vocabulary. Native messages can
// contain SQL, row values or credentials; inspect causes only to choose status.
export function httpFailure(error) {
 if (error instanceof PortabilityError) return { status: error.status, body: { error: error.code,
  ...(error.code === 'import_running' ? { jobId: error.jobId, abortableAt: error.abortableAt } : {}) } };
 if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
  const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : 'operation_failed';
  return { status: error.status, body: { error: code } };
 }
 const seen = new Set();
 for (let cause = error; cause && !seen.has(cause) && seen.size < 5; cause = cause.cause) {
  seen.add(cause);
  if (cause.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(cause.code))
   return { status: 504, body: { error: 'operation_failed' } };
  if (['ECONNRESET', 'ECONNREFUSED', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(cause.code)
   || /\bD1_ERROR\b/i.test(cause.message ?? '') && /overloaded|temporarily unavailable|reset|timed? out|timeout|SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(cause.message))
   return { status: 503, body: { error: 'operation_failed' } };
 }
 return { status: 500, body: { error: 'operation_failed' } };
}
