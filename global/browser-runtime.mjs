// An older checkout pin still runs its own verbs. The installed launcher
// supplies the browser prerequisite those pins did not yet provision.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 const cancellation = new AbortController();
 let directory, store, termination;
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => { termination ??= name; cancellation.abort(name); }]));
 for (const [name, handler] of handlers) process.on(name, handler);
 try {
  directory = await mkdtemp(join(tmpdir(), 'rer-browser-'));
  const { createCommands } = await shared('commands.mjs');
  store = await createCommands(directory, { logs: [] }, { terminal: text => out.progress(text) });
  store.setCommandSignal(cancellation.signal);
  // A fresh vendored pin installs its own dependencies; verify will acquire
  // their browser on first need. Package pins have already been bootstrapped.
  await ensureChromium(root, store, cancellation.signal, { required: verb === 'verify' });
 } catch (error) {
  const failure = error instanceof RerError ? error : new RerError('browser_install_failed', `The checkout's Chromium installation failed. Run rer install to retry; inspect the browser download progress for the cause.`, 1);
  if (termination) { failure.exitCode = termination === 'SIGINT' ? 130 : 143; failure.message = `Stopped by ${termination} after owned children were stopped.`; }
  out.error(failure); out.result(false, failure.exitCode);
  return failure.exitCode;
 } finally {
  try { await store?.closeCommands(); }
  finally {
   if (directory) await rm(directory, { recursive: true, force: true });
   for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
 }
}
