import { handleBrokenPipes } from './stdio.mjs';
import { exportSummary } from './export-summary.mjs';
import { importSafetySummary } from './import-summary.mjs';
export function output(options) {
 handleBrokenPipes();
 let finished = false;
 // A bounded child retains the caller's human progress but sends its closing
 // outcome as data, so only the drained outer workflow renders the result.
 const structuredResult = options.json || process.env.RER_BOUNDED_OUTPUT === '1';
 // Pipes can accept only part of a synchronous write (512 bytes on macOS).
 // Writable streams queue every byte under backpressure; the entry points set
 // exitCode so Node drains that queue before exiting naturally.
 const write = (fd, text) => { const stream = fd === 1 ? process.stdout : process.stderr; if (!stream.destroyed) stream.write(text); };
 return {
  event(event, details = {}) { write(1, JSON.stringify({ version: 1, verb: options.verb ?? 'unknown', event, ...details }) + '\n'); },
  human(text) { write(1, text + '\n'); },
  progress(text) { write(2, text); },
  result(ok, exitCode, details = {}) {
   if (finished) throw Error('Duplicate CLI result'); finished = true;
   if (structuredResult) this.event('result', { ok, exitCode, ...details });
   // A finished export ends with one line naming its archive; the receipt is --json data.
   else if (options.verb === 'export' && (ok || details.hostedExport) && exportSummary({ ...details, exitCode })) this.human(exportSummary({ ...details, exitCode }));
   else if (ok && options.verb === 'import' && importSafetySummary(details)) this.human('import: complete (exit 0)\n' + importSafetySummary(details));
   else if (!['describe', 'check', 'dev', 'preview', 'setup'].includes(options.verb) || !ok) this.human(`${options.verb}: ${ok ? 'complete' : 'failed'} (exit ${exitCode})`);
  },
  error(error) {
   if (structuredResult) this.event('error', { code: error.code, message: error.message, exitCode: error.exitCode, ...(error.availableDeployments ? { environment: error.environment, availableDeployments: error.availableDeployments } : {}), ...(error.step ? { step: error.step } : {}) });
   else write(2, error.message + '\n');
  },
 };
}
