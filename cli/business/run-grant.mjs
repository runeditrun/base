import { randomUUID } from 'node:crypto';
import { Api, identifier } from './api.mjs';
import { paired } from './local-commands.mjs';
import { runChild, signalCode } from './run-child.mjs';

const route = '/api/business/executors/cloudflare-token';
const usage = 'Usage: rer business run --grant G -- <command> [args...]\n';
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
 } catch { /* A lost acknowledgement is unconfirmed, never success. */ }
 return 'unconfirmed';
}
export async function cleanupCommand(args) {
 if (args.length < 1 || args.length > 2 || args[1] !== undefined && args[1] !== '--status' || !/^[a-f0-9-]{36}$/.test(args[0])) {
  process.stderr.write('Usage: rer business cleanup LEASE [--status]\n'); return 2;
 }
 const {state, credential} = await paired(), api = new Api(state.origin, credential), id = args[0];
 try {
  const value = args[1] ? await api.request('GET', `${route}/${id}`, undefined, { quiet: true }) : null;
  const status = args[1] ? value?.lease_id === id && ['issuing','active','revoked','unconfirmed','expired'].includes(value.cleanup_status) ? value.cleanup_status : 'unconfirmed' : await cleanup(api, id);
  process.stderr.write(`Cloud credential cleanup: ${status}. Lease ${id}.\n`);
  return ['revoked','expired'].includes(status) ? 0 : 1;
 } catch { process.stderr.write(`Cloud credential cleanup: unconfirmed. Lease ${id}.\n`); return 1; }
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
  lease = await api.post(route, {grant_id: args[1], lease_id: id}, {quiet: true, signal: stop.signal});
  if (!validLease(lease, state, args[1], id) || lease.credential === credential) throw Error('invalid credential exchange');
  const expiry = new Date(lease.credential_expires_at).toISOString(), minutes = Math.ceil((Date.parse(expiry) - Date.now()) / 60000);
  process.stderr.write(`Cloud credential expiry: ${expiry} (${minutes} ${minutes === 1 ? 'minute' : 'minutes'} remaining).\n`);
  const result = await runChild(args.slice(3), lease, {signal: stop.signal});
  code = result.code; exitSignal = result.signal;
  if (result.credentialExpired) process.stderr.write(`Command stopped because the credential expired; run it again to resume. Caller exit status: ${code}${exitSignal ? ` (${exitSignal})` : ''}.\n`);
 } catch {
  code = stop.signal.aborted ? signalCode(stop.signal.reason.signal) : 1;
  process.stderr.write('Business command refused or its credential exchange failed. Check pairing, selected account, deploy action, grant and Cloudflare consent in Business.\n');
 } finally {
  const status = await cleanup(api, id);
  const expiry = lease && Number.isFinite(Date.parse(lease.credential_expires_at)) ? new Date(lease.credential_expires_at).toISOString() : 'the server-enforced expiry (at most 15 minutes)';
  process.stderr.write(`Cloud credential cleanup: ${status}. Lease ${id}.${status === 'unconfirmed' ? ` Credential expiry: ${expiry}. Retry: rer business cleanup ${id}.` : ''}\n`);
  lease = undefined;
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
 }
 // Keep the child's exit status even if cleanup is unconfirmed; cleanup has its own explicit status above.
 exitSignal ??= stop.signal.reason?.signal;
 if (exitSignal && process.platform !== 'win32') { process.kill(process.pid, exitSignal); await new Promise(resolve => setImmediate(resolve)); }
 return code;
}
