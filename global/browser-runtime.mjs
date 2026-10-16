// An older checkout pin still runs its own verbs. The installed launcher
// supplies the browser prerequisite those pins did not yet provision.
import { browserDoctor, ensureChromium } from '../cli/browser-runtime.mjs';
import { output } from '../cli/output.mjs';
import { RerError } from '../cli/errors.mjs';
import { shared } from '../cli/shared.mjs';

export async function browserPreflight(root, argv) {
 const verb = argv[0], out = output({ verb, json: argv.includes('--json') });
 if (verb === 'doctor') {
  const browser = await browserDoctor(root);
  if (browser.ok) return;
  const diagnostics = { browser, ok: false, scope: 'browser-prerequisite' };
  if (!argv.includes('--json')) out.human(JSON.stringify(diagnostics, null, 2));
  out.result(false, 3, { diagnostics });
  return 3;
 }
 // Installed browsers need no download, and no log.
 if ((await browserDoctor(root).catch(() => ({ ok: false }))).ok) return;
 const cancellation = new AbortController();
 const state = { logs: [], step: 'Checking the checkout’s Playwright browsers' };
 let store, termination;
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => { termination ??= name; cancellation.abort(name); }]));
 for (const [name, handler] of handlers) process.on(name, handler);
 try {
  // The browser download's full output stays in the checkout's private installer log.
  const { privateDirectory } = await shared('private-files.mjs');
  const { createCommands } = await shared('commands.mjs');
  store = await createCommands(await privateDirectory(root, ['.seed', 'installer', `browser-${process.pid}`]), state, { terminal: text => out.progress(text) });
  store.setCommandSignal(cancellation.signal);
  // A fresh vendored pin installs its own dependencies; verify will acquire
  // their browser on first need. Package pins have already been bootstrapped.
  await ensureChromium(root, store, cancellation.signal, { required: verb === 'verify' });
 } catch (error) {
  const failure = termination ? new RerError('cancelled', `Stopped by ${termination} after owned children were stopped.`, termination === 'SIGINT' ? 130 : 143) : await browserStepError(error, store, state, root);
  out.error(failure); out.result(false, failure.exitCode);
  return failure.exitCode;
 } finally {
  try { await store?.closeCommands(); }
  finally { for (const [name, handler] of handlers) process.removeListener(name, handler); }
 }
}

// The failed browser step names itself, its command, exit code, last output and log.
async function browserStepError(error, store, state, root) {
 const { approvedFailure } = await shared('failures.mjs');
 const { checkoutPath, stepDiagnostic, stepFailureText } = await shared('step-failure.mjs');
 const step = approvedFailure(error)?.step ?? stepDiagnostic({ name: state.step, output: state.logs, log: store ? store.redact(checkoutPath(root, store.logPath)) : null });
 const cause = error instanceof RerError ? `\n${error.message}` : /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? `\nCause: ${error.code}` : '';
 return new RerError(error instanceof RerError ? error.code : 'browser_install_failed', `${stepFailureText(step)}${cause}\nRun rer install to retry.`, error instanceof RerError ? error.exitCode : 1, { step });
}
