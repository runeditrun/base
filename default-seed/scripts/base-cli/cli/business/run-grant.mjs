import { randomUUID } from 'node:crypto';
import { Api, ApiError, identifier } from './api.mjs';
import { redact } from './errors.mjs';
import { paired } from './local-commands.mjs';
import { runChild, signalCode } from './run-child.mjs';

const route = '/api/business/executors/cloudflare-token';
const usage = 'Usage: rer business run --grant G -- <command> [args...]\n';
const refused = 'Business command refused or its credential exchange failed. Check pairing, selected account, deploy action, grant and Cloudflare consent in Business.';
// A refused exchange can say why its grant cannot mint (409 {state, gap, catalogue}). Only the gap sentence, whether the
// grant stays pending and the catalogue's two counts are read: no other key, and never a token, header or value.
function exchangeGap(body) {
 const gap = typeof body.gap === 'string' ? redact(body.gap).replace(/\s+/g, ' ').trim() : '';
 const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
 const rows = count(body.catalogue?.rows), workers = count(body.catalogue?.workers_rows);
 return { gap: gap.length > 2000 ? `${gap.slice(0, 1999)}…` : gap, pending: body.state === 'pending',
  catalogue: rows === null || workers === null ? null : { rows, workers } };
}
function refusalLine({ gap, pending, catalogue } = {}) {
 return [gap ? `Not started: ${gap}${/[.!?…]$/.test(gap) ? '' : '.'}` : refused, pending && 'The grant stays pending; nothing was issued.',
  catalogue && `catalogue: ${catalogue.rows} rows, ${catalogue.workers} mention Workers (see the audit row cloudflare.token.catalogue)`]
  .filter(Boolean).join(' ') + '\n';
}
function validLease(value, state, grant, id) {
 return value?.lease_id === id && value.grant_id === grant && value.business_id === state.businessId && value.executor_id === state.executorId
  && /^[a-f0-9]{32}$/.test(value.account_id) && typeof value.credential === 'string' && value.credential.length >= 16 && value.credential.length <= 4096
  && !/[\s\x00-\x1f\x7f]/.test(value.credential) && value.cleanup_status === 'active' && value.provider_credential_revoked === false
  && Number.isFinite(Date.parse(value.credential_expires_at)) && Date.parse(value.credential_expires_at) > Date.now()
  && Date.parse(value.credential_expires_at) <= Date.now() + 900_000;
}
async function cleanup(api, id) {
 try {
  const value = await api.post(`${route}/${id}/revoke`, {}, { quiet: true, timeout: 15000 });
  if (value?.lease_id === id && ['revoked', 'expired'].includes(value.cleanup_status)
   && (value.cleanup_status !== 'revoked' || value.provider_credential_revoked === true)) return value.cleanup_status;
 } catch (error) {
  if (error instanceof ApiError && error.status === 404) return 'not-issued';
  // A lost acknowledgement is unconfirmed, never success.
 }
 return 'unconfirmed';
}
function cleanupLine(id, status, suffix = '') {
 return status === 'not-issued' ? 'No cloud credential was issued; there is nothing to clean up.\n'
  : `Cloud credential cleanup: ${status}. Lease ${id}.${suffix}\n`;
}
export async function cleanupCommand(args) {
 if (args.length < 1 || args.length > 2 || args[1] !== undefined && args[1] !== '--status' || !/^[a-f0-9-]{36}$/.test(args[0])) {
  process.stderr.write('Usage: rer business cleanup LEASE [--status]\n'); return 2;
 }
 const {state, credential} = await paired(), api = new Api(state.origin, credential), id = args[0];
 try {
  const value = args[1] ? await api.request('GET', `${route}/${id}`, undefined, { quiet: true }) : null;
  const status = args[1] ? value?.lease_id === id && ['issuing','active','revoked','unconfirmed','expired'].includes(value.cleanup_status) ? value.cleanup_status : 'unconfirmed' : await cleanup(api, id);
  process.stderr.write(cleanupLine(id, status));
  return ['revoked','expired'].includes(status) ? 0 : 1;
 } catch (error) {
  process.stderr.write(cleanupLine(id, error instanceof ApiError && error.status === 404 ? 'not-issued' : 'unconfirmed')); return 1;
 }
}
export async function grantCommand(args) {
 if (args[0] !== '--grant' || !args[1] || args[2] !== '--' || !args[3]) { process.stderr.write(usage); return 2; }
 try { identifier(args[1]); } catch { process.stderr.write(usage); return 2; }
 const {state, credential} = await paired(), api = new Api(state.origin, credential), id = randomUUID();
 const stop = new AbortController(), handlers = new Map();
 for (const signal of ['SIGINT','SIGTERM','SIGHUP']) {
  const handler = () => { if (!stop.signal.aborted) stop.abort({signal}); };
  handlers.set(signal, handler); process.on(signal, handler);
 }
 let lease, code = 1, exitSignal;
 try {
  // No automatic retry: a lost response may already have minted a child. Cleanup uses the preselected lease id.
  lease = await api.post(route, {grant_id: args[1], lease_id: id}, {quiet: true, signal: stop.signal, detail: exchangeGap});
  if (!validLease(lease, state, args[1], id) || lease.credential === credential) throw Error('invalid credential exchange');
  const expiry = new Date(lease.credential_expires_at).toISOString(), minutes = Math.ceil((Date.parse(expiry) - Date.now()) / 60000);
  process.stderr.write(`Cloud credential expiry: ${expiry} (${minutes} ${minutes === 1 ? 'minute' : 'minutes'} remaining).\n`);
  const result = await runChild(args.slice(3), lease, {signal: stop.signal, source: {...process.env, RER_BUSINESS_GRANT: args[1]}});
  code = result.code; exitSignal = result.signal;
  if (result.credentialExpired) process.stderr.write(`Command stopped because the credential expired; run it again to resume. Caller exit status: ${code}${exitSignal ? ` (${exitSignal})` : ''}.\n`);
 } catch (error) {
  code = stop.signal.aborted ? signalCode(stop.signal.reason.signal) : 1;
  process.stderr.write(refusalLine(error instanceof ApiError ? error.detail : undefined));
 } finally {
  const status = await cleanup(api, id);
  const expiry = lease && Number.isFinite(Date.parse(lease.credential_expires_at)) ? new Date(lease.credential_expires_at).toISOString() : 'the server-enforced expiry (at most 15 minutes)';
  process.stderr.write(cleanupLine(id, status, status === 'unconfirmed' ? ` Credential expiry: ${expiry}. Retry: rer business cleanup ${id}.` : ''));
  lease = undefined;
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
 }
 // Keep the child's exit status even if cleanup is unconfirmed; cleanup has its own explicit status above.
 exitSignal ??= stop.signal.reason?.signal;
 if (exitSignal && process.platform !== 'win32') { process.kill(process.pid, exitSignal); await new Promise(resolve => setImmediate(resolve)); }
 return code;
}
