import { win32 } from 'node:path';
import { transferDiagnostic } from '../modules/portability/http-client.mjs';

export class RerError extends Error {
 constructor(code, message, exitCode, details = {}) { super(message); Object.assign(this, { code, exitCode, ...details }); }
}
export const invalid = message => new RerError('invalid_invocation', message, 2);
export const missing = message => new RerError('missing_input', message, 3);
export const refuse = message => new RerError('safety_refusal', message, 4);


// Raw child errors reach the terminal catch before lifecycle capture can classify
// them. Use Node's structured spawn fields; its message may contain private argv.
export function unexpectedFailure(error) {
 const exitCode = [error?.exitCode, error?.status].find(value => Number.isInteger(value) && value > 0) ?? 1;
 const details = { cause: error };
 if (typeof error?.path === 'string' && ['spawn', 'spawnSync', `spawn ${error.path}`, `spawnSync ${error.path}`].includes(error.syscall)) {
  const basename = win32.basename(error.path);
  const executable = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(basename) ? `"${basename}"` : 'the child executable';
  const errno = Number.isInteger(error.errno) ? error.errno : undefined;
  const code = typeof error.code === 'string' && (/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) || (errno !== undefined && error.code === `Unknown system error ${errno}`)) ? error.code : undefined;
  const fields = [code === undefined ? undefined : `code: ${code}`, errno === undefined ? undefined : `errno: ${errno}`].filter(value => value !== undefined);
  // Darwin sys/errno.h defines EBADARCH as 86; libuv may leave -86 unnamed.
  // Other operating systems' errno numbers do not establish this diagnosis.
  const badArchitecture = error.code === 'EBADARCH' || (process.platform === 'darwin' && errno === -86);
  return new RerError('command_failed', `Could not start ${executable}${fields.length ? ` (${fields.join(', ')})` : ''}.${badArchitecture ? ' EBADARCH: executable built for the wrong architecture.' : ''}`, exitCode, { ...details, childErrorCode: error.code, errno });
 }
 // Unclassified errors keep their own first line and existing recovery hint.
 const message = String(error?.message ?? error).split('\n')[0].trim().slice(0, 300);
 return new RerError('command_failed', `${message || 'Command failed.'}\nUnexpected failure: run the command again, and if it repeats inspect the project operating documentation.`, exitCode, details);
}

export async function lifecycleError(error, store) {
 if(error instanceof RerError)return error;
 const transfer=transferDiagnostic(error);
 if(transfer)return new RerError('transfer_failed',transfer,1);
 const {shared}=await import('./shared.mjs');
 const {approvedFailure}=await shared('failures.mjs');
 const approved=approvedFailure(error);
 return new RerError(['owner_conflict','machine_busy'].includes(approved?.code)?'safety_refusal':'command_failed', approved?.message ?? `${store?.state?.step ?? 'Local lifecycle'} failed. Inspect the private redacted capture log.`, approved?.exitCode ?? 1, {childExitCode:approved?.childExitCode,signal:approved?.signal});
}
