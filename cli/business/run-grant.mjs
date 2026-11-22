import { randomUUID } from 'node:crypto';
import { Api, ApiError, identifier } from './api.mjs';
import { refusalView, serverSaid } from './refusal.mjs';
import { paired } from './local-commands.mjs';
import { runChild, signalCode } from './run-child.mjs';

// A grant id names its provider: the Business's GitHub grants start with `github-`; every other grant is Cloudflare's.
const routes = { cloudflare: '/api/business/executors/cloudflare-token', github: '/api/business/executors/github-token' };
const kindOf = grant => grant.startsWith('github-') ? 'github' : 'cloudflare';
// A Cloudflare child lasts at most 15 minutes; a GitHub installation token at most an hour (GitHub's own fixed lifetime,
// timed from GitHub's clock, so a minute of skew is allowed).
const longest = { cloudflare: 900_000, github: 3_660_000 };
const usage = 'Usage: ~/.local/bin/rer business run --grant G -- <command> [args...]\n';
const refused = 'Business command refused or its credential exchange failed. Check pairing, selected account, deploy action, grant and Cloudflare consent in Business.';
// Read only safe prose, the pending flag and the catalogue's two counts.
function exchangeGap(body) {
 const view = refusalView(body, 2000), gap = view.line(body.gap);
 const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
 const rows = count(body.catalogue?.rows), workers = count(body.catalogue?.workers_rows);
 return { gap, reason: refusalView({ ...body, gap: undefined }, 500).sentence, pending: body.state === 'pending',
  catalogue: rows === null || workers === null ? null : { rows, workers } };
}
function refusalLine({ gap, reason, pending, catalogue } = {}) {
 return [(gap ? `Not started: ${gap}${/[.!?…]$/.test(gap) ? '' : '.'}` : refused) + serverSaid(reason), pending && 'The grant stays pending; nothing was issued.',
  catalogue && `catalogue: ${catalogue.rows} rows, ${catalogue.workers} mention Workers (see the audit row cloudflare.token.catalogue)`]
  .filter(Boolean).join(' ') + '\n';
}
function validLease(value, state, grant, id, kind) {
 const scope = kind === 'github' ? /^[A-Za-z0-9-]{1,39}$/.test(value?.org) && Array.isArray(value.repositories) && value.repositories.length > 0
  && value.repositories.every(name => typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name)) : /^[a-f0-9]{32}$/.test(value?.account_id);
 return value?.lease_id === id && value.grant_id === grant && value.business_id === state.businessId && value.executor_id === state.executorId
  && scope && typeof value.credential === 'string' && value.credential.length >= 16 && value.credential.length <= 4096
  && !/[\s\x00-\x1f\x7f]/.test(value.credential) && value.cleanup_status === 'active' && value.provider_credential_revoked === false
  && Number.isFinite(Date.parse(value.credential_expires_at)) && Date.parse(value.credential_expires_at) > Date.now()
  && Date.parse(value.credential_expires_at) <= Date.now() + longest[kind];
}
async function cleanup(api, id, kind) {
 try {
  const value = await api.post(`${routes[kind]}/${id}/revoke`, {}, { quiet: true, timeout: 15000 });
  if (value?.lease_id === id && ['revoked', 'expired'].includes(value.cleanup_status)
   && (value.cleanup_status !== 'revoked' || value.provider_credential_revoked === true)) return { status: value.cleanup_status };
 } catch (error) { return { status: 'unconfirmed', reason: error instanceof ApiError ? error.reason : null }; }
 return { status: 'unconfirmed' };
}
export async function cleanupCommand(args) {
 const flags = args.slice(1);
 if (args.length < 1 || args.length > 3 || flags.some(flag => !['--status', '--github'].includes(flag)) || new Set(flags).size !== flags.length || !/^[a-f0-9-]{36}$/.test(args[0])) {
  process.stderr.write('Usage: ~/.local/bin/rer business cleanup LEASE [--github] [--status]\n'); return 2;
 }
 const {state, credential} = await paired(), api = new Api(state.origin, credential), id = args[0];
 const kind = flags.includes('--github') ? 'github' : 'cloudflare', statusOnly = flags.includes('--status');
 try {
  const value = statusOnly ? await api.request('GET', `${routes[kind]}/${id}`, undefined, { quiet: true }) : null;
  const { status, reason } = statusOnly ? { status: value?.lease_id === id && ['issuing','active','revoked','unconfirmed','expired'].includes(value.cleanup_status) ? value.cleanup_status : 'unconfirmed' } : await cleanup(api, id, kind);
  process.stderr.write(`Cloud credential cleanup: ${status}. Lease ${id}.${serverSaid(reason)}\n`);
  return ['revoked','expired'].includes(status) ? 0 : 1;
 } catch (error) { process.stderr.write(`Cloud credential cleanup: unconfirmed. Lease ${id}.${serverSaid(error instanceof ApiError ? error.reason : null)}\n`); return 1; }
}
export async function grantCommand(args) {
 if (args[0] !== '--grant' || !args[1] || args[2] !== '--' || !args[3]) { process.stderr.write(usage); return 2; }
 try { identifier(args[1]); } catch { process.stderr.write(usage); return 2; }
 const {state, credential} = await paired(), api = new Api(state.origin, credential), id = randomUUID(), kind = kindOf(args[1]);
 const stop = new AbortController(), handlers = new Map();
 for (const signal of ['SIGINT','SIGTERM','SIGHUP']) {
  const handler = () => { if (!stop.signal.aborted) stop.abort({signal}); };
  handlers.set(signal, handler); process.on(signal, handler);
 }
 let lease, code = 1, exitSignal;
 try {
  // No automatic retry: a lost response may already have minted a child. Cleanup uses the preselected lease id.
  lease = await api.post(routes[kind], {grant_id: args[1], lease_id: id}, {quiet: true, signal: stop.signal, detail: exchangeGap});
  if (!validLease(lease, state, args[1], id, kind) || lease.credential === credential) throw Error('invalid credential exchange');
  const expiry = new Date(lease.credential_expires_at).toISOString(), minutes = Math.ceil((Date.parse(expiry) - Date.now()) / 60000);
  process.stderr.write(`Cloud credential expiry: ${expiry} (${minutes} ${minutes === 1 ? 'minute' : 'minutes'} remaining).\n`);
  const result = await runChild(args.slice(3), {...lease, kind}, {signal: stop.signal, source: {...process.env, RER_BUSINESS_GRANT: args[1]}});
  code = result.code; exitSignal = result.signal;
  if (result.credentialExpired) process.stderr.write(`Command stopped because the credential expired; run it again to resume. Caller exit status: ${code}${exitSignal ? ` (${exitSignal})` : ''}.\n`);
 } catch (error) {
  code = stop.signal.aborted ? signalCode(stop.signal.reason.signal) : 1;
  process.stderr.write(refusalLine(error instanceof ApiError ? error.detail ?? { reason: error.reason } : undefined));
 } finally {
  const { status, reason } = await cleanup(api, id, kind);
  const expiry = lease && Number.isFinite(Date.parse(lease.credential_expires_at)) ? new Date(lease.credential_expires_at).toISOString() : `the server-enforced expiry (at most ${kind === 'github' ? 'an hour' : '15 minutes'})`;
  process.stderr.write(`Cloud credential cleanup: ${status}. Lease ${id}.${serverSaid(reason)}${status === 'unconfirmed' ? ` Credential expiry: ${expiry}. Retry: ~/.local/bin/rer business cleanup ${id}${kind === 'github' ? ' --github' : ''}.` : ''}\n`);
  lease = undefined;
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
 }
 // Keep the child's exit status even if cleanup is unconfirmed; cleanup has its own explicit status above.
 exitSignal ??= stop.signal.reason?.signal;
 if (exitSignal && process.platform !== 'win32') { process.kill(process.pid, exitSignal); await new Promise(resolve => setImmediate(resolve)); }
 return code;
}
