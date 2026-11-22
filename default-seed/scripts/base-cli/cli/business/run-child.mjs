import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { commandMask, deviceCredentialValues } from './run-mask.mjs';

export const signalCode = signal => 128 + (constants.signals[signal] ?? 1);
/** The command sees only its grant's credential: every ambient Cloudflare or GitHub credential variable is removed, then a
 * Cloudflare lease sets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and a GitHub lease (`kind: 'github'`) GH_TOKEN and
 * GITHUB_TOKEN, which gh and GitHub's own tools read. */
export function childEnvironment(source, lease) {
 const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
  !/^(?:CLOUDFLARE_|CF_|MANAGED_CLOUDFLARE_|GH_|GITHUB_TOKEN$|GITHUB_PAT|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$)/i.test(key)));
 return lease.kind === 'github' ? { ...env, GH_TOKEN: lease.credential, GITHUB_TOKEN: lease.credential }
  : { ...env, CLOUDFLARE_API_TOKEN: lease.credential, CLOUDFLARE_ACCOUNT_ID: lease.account_id };
}
/** Own one process group, forward interruption, and bound its lifetime to the credential's server expiry. */
export async function runChild(command, lease, { signal, source = process.env, output = process.stdout, errors = process.stderr } = {}) {
 const values = [lease.credential, lease.account_id, ...deviceCredentialValues()], stdout = commandMask(values, output), stderr = commandMask(values, errors);
 let child, escalation, expiry, stopped, credentialExpired = false;
 const stop = reason => {
  stopped ??= reason;
  if (!child?.pid) return;
  const send = sig => { try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  send(reason);
  escalation ??= setTimeout(() => send('SIGKILL'), 3000);
 };
 const interrupt = () => stop(signal.reason?.signal ?? 'SIGTERM');
 try {
  if (signal?.aborted) return { code: signalCode(signal.reason?.signal ?? 'SIGTERM'), signal: signal.reason?.signal };
  child = spawn(command[0], command.slice(1), { env: childEnvironment(source, lease),
   stdio: ['inherit', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
  child.stdout.on('data', stdout.write); child.stderr.on('data', stderr.write);
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  expiry = setTimeout(() => { if (!stopped) credentialExpired = true; stop('SIGTERM'); }, Math.max(1, Date.parse(lease.credential_expires_at) - Date.now()));
  const result = await new Promise(resolve => {
   let spawnError;
   child.on('error', error => { spawnError = error; });
   child.on('close', (code, exitSignal) => resolve(spawnError ? { code: spawnError.code === 'ENOENT' ? 127 : 126, spawnError: spawnError.code }
    : { code: code ?? signalCode(exitSignal ?? stopped ?? 'SIGTERM'), signal: exitSignal }));
  });
  if (result.spawnError) errors.write(`Command could not start (${String(result.spawnError).replace(/[^A-Z0-9_]/g, '')}).\n`);
  return { ...result, credentialExpired };
 } finally {
  clearTimeout(expiry); clearTimeout(escalation); signal?.removeEventListener('abort', interrupt);
  stdout.end(); stderr.end();
 }
}
