import { transferDiagnostic } from '../modules/portability/http-client.mjs';
import { nativeFailure } from './portability-progress.mjs';
import { relative } from 'node:path';

export class RerError extends Error {
 constructor(code, message, exitCode, details = {}) { super(message); Object.assign(this, { code, exitCode, ...details }); }
}
export const invalid = message => new RerError('invalid_invocation', message, 2);
export const missing = message => new RerError('missing_input', message, 3);
export const refuse = message => new RerError('safety_refusal', message, 4);

export async function lifecycleError(error, store) {
 if(error instanceof RerError)return error;
 const transfer=transferDiagnostic(error);
 if(transfer)return new RerError('transfer_failed',transfer,1);
 const {shared}=await import('./shared.mjs');
 const {approvedFailure}=await shared('failures.mjs');
 const approved=approvedFailure(error);
 const native=nativeFailure(error);
 return new RerError(['owner_conflict','machine_busy'].includes(approved?.code)?'safety_refusal':'command_failed', approved?.message ?? `${store?.state?.step ?? 'Local lifecycle'} failed (${native.class}${native.code ? `, code ${native.code}` : ''}).`, approved?.exitCode ?? 1, {childExitCode:approved?.childExitCode,signal:approved?.signal,...(approved?.d1Import ? {d1Import:approved.d1Import} : {})});
}

// Only classified diagnostics reach this boundary: unexpected native messages
// can contain SQL or row values. Name a log only after its failure entry writes.
export function retainTransferFailure(error,store,root) {
 if(!store?.logPath){error.message+=' No capture log was created.';return error;}
 try {
  store.report(`${error.code}: ${error.message}`,{logOnly:true});
  error.message+=`\nFull output: ${store.redact(relative(root,store.logPath))}`;
 } catch { error.message+=' The private capture log could not be written.'; }
 return error;
}
