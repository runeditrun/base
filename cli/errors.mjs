import { transferDiagnostic } from '../modules/portability/http-client.mjs';
import { nativeFailure } from './portability-progress.mjs';
import { basename, relative } from 'node:path';
import { getSystemErrorMessage } from 'node:util';

export class RerError extends Error {
 constructor(code, message, exitCode, details = {}) { super(message); Object.assign(this, { code, exitCode, ...details }); }
}
export const invalid = message => new RerError('invalid_invocation', message, 2);
export const missing = message => new RerError('missing_input', message, 3);
export const refuse = message => new RerError('safety_refusal', message, 4);

export async function lifecycleError(error, store) {
 let failure = error, classified = error instanceof RerError;
 if (!(error instanceof RerError)) {
  const transfer = transferDiagnostic(error);
  if (transfer) { classified = true; failure = new RerError('transfer_failed', transfer, 1, { cause: error }); }
  else {
   const { shared } = await import('./shared.mjs');
   const { approvedFailure } = await shared('failures.mjs');
   const approved = approvedFailure(error), native = nativeFailure(error);
   classified = Boolean(approved);
   failure = new RerError(['owner_conflict', 'machine_busy'].includes(approved?.code) ? 'safety_refusal' : 'command_failed', approved?.message ?? `${store?.state?.step ?? 'Local lifecycle'} failed (${native.class}${native.code ? `, code ${native.code}` : ''}).`, approved?.exitCode ?? 1, { cause: error, childExitCode: approved?.childExitCode, signal: approved?.signal, ...(approved?.d1Import ? { d1Import: approved.d1Import } : {}) });
  }
 }
 const spawn = spawnDiagnostic(error);
 if (!spawn) return failure;
 // Keep native objects as causes, but expose only classified spawn facts. A
 // native message, executable path or argv may contain private application data.
 failure.message = classified ? `${failure.message}\n${spawn}` : spawn;
 return retainSpawnFailure(failure, store);
}

function spawnDiagnostic(error) {
 const seen = new Set();
 while (error && !seen.has(error)) {
  seen.add(error);
  if (/^spawn(?:Sync)?(?: |$)/.test(error.syscall ?? '')) {
   const tool = typeof error.path === 'string' && error.path ? basename(error.path).slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '') : 'child process';
   const code = /^E[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : undefined;
   const errno = Number.isSafeInteger(error.errno) && error.errno < 0 ? error.errno : undefined;
   const nativeReason = errno === undefined ? undefined : getSystemErrorMessage(errno);
   const reason = process.platform === 'darwin' && errno === -86 ? 'Bad CPU type in executable' : process.platform === 'darwin' && errno === -85 ? 'Executable damaged or invalid' : code === 'ENOENT' ? 'Executable or interpreter not found' : code === 'ENOEXEC' ? 'Exec format error' : ['EACCES', 'EPERM'].includes(code) ? 'Permission denied' : nativeReason ? nativeReason[0].toUpperCase() + nativeReason.slice(1) : 'Operating system refused execution';
   return `Could not run ${tool}: ${reason} (${[code, errno === undefined ? undefined : `spawn errno ${errno}`].filter(Boolean).join('; ') || 'spawn failed'}).`;
  }
  error = error.cause;
 }
}

function retainSpawnFailure(error, store) {
 if (!store?.logPath) { error.message += ' No capture log was created.'; return error; }
 const message = store.redact(`${error.message}\nFull output: ${store.logPath}`);
 try { store.report(`${error.code}: ${message}`, { logOnly: true }); error.message = message; }
 catch { error.message += ' The private capture log could not be written.'; }
 return error;
}

// Only classified diagnostics reach this boundary: unexpected native messages
// can contain SQL or row values. Name a log only after its failure entry writes.
export function retainTransferFailure(error,store,root) {
 if (spawnDiagnostic(error)) return error;
 if(!store?.logPath){error.message+=' No capture log was created.';return error;}
 try {
  store.report(`${error.code}: ${error.message}`,{logOnly:true});
  error.message+=`\nFull output: ${store.redact(relative(root,store.logPath))}`;
 } catch { error.message+=' The private capture log could not be written.'; }
 return error;
}
