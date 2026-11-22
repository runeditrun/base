import { Worker } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { userInfo } from 'node:os';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ensureChromium, browsersPresent } from './browser-runtime.mjs';
import { invalid, missing, RerError } from './errors.mjs';

const browserSetupTimeout = 300000;

// Use the browser protocol itself: fragment exchange, cookies, server and
// client redirects, and rendered content. No application destination is fixed.
export async function ownerEntryReady(root, link, signal, store, { persona = false, startupLog = store?.logPath } = {}) {
 // A freshly started dev server can still be compiling its first client
 // module graph. A reattach only checks an already running application.
 const timeout = Number(process.env.RER_OWNER_READY_TIMEOUT_MS ?? (store ? 180000 : 60000));
 if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw invalid('RER_OWNER_READY_TIMEOUT_MS must be positive integer milliseconds, at most 2147483647.');
 const homeOverride = process.env.RER_OWNER_BROWSER_HOME;
 if (homeOverride !== undefined && (!isAbsolute(homeOverride) || !(await stat(homeOverride).catch(() => null))?.isDirectory())) {
  throw invalid('RER_OWNER_BROWSER_HOME must be an absolute path to an existing directory.');
 }
 const log = startupLog ? `Startup log: ${store?.redact(startupLog) ?? startupLog}. ` : '';
 // A cold download (or its queue wait) must not spend the page's render budget.
 if (store) {
  const setupTimeout = AbortSignal.timeout(browserSetupTimeout);
  try {
   await ensureChromium(root, store, AbortSignal.any([signal, setupTimeout].filter(Boolean)));
  } catch (error) {
   signal?.throwIfAborted();
   if (!setupTimeout.aborted) throw error;
   throw new RerError('owner_entry_not_ready', `Headless Chromium setup did not finish within ${browserSetupTimeout / 1000} seconds. No ready link was announced. ${log}Run the command again to resume browser setup.`, 1);
  }
 } else if (!await browsersPresent(root)) {
  throw missing(`Owner entry verification needs the checkout’s headless browser. ${log}Run ~/.local/bin/rer verify to provision it, then run the command again.`);
 }
 // macOS Chromium expects the account's system home for keychain services.
 // Playwright still creates a temporary profile for every launch. Cache and
 // project lookup take place in the worker with the installer's original HOME.
 const browserHome = homeOverride ?? (process.platform === 'darwin' ? userInfo().homedir : undefined);
 const entry = new URL(link), began = performance.now();
 const { result, browserExit } = await runProbe({ root, link, timeout, browserHome }, signal);
 signal?.throwIfAborted();
 if (result?.ready) return;
 const entryName = entry.origin + entry.pathname;
 const last = result ? `${result.destination}: ${result.last}. ${result.client}.` : `${entryName}: browser did not open the entry.`;
 const diagnostics = result?.stopped || !result
  ? ` ${result?.stopped ?? 'Owner-entry browser probe stopped'}${browserExit ? ` (${browserExit})` : ''}.`
  : '';
 // A browser that stopped early is reported at the time it stopped, never as the whole budget.
 const stoppedAt = result ? (result.stopped ? result.observedAt : timeout) : Math.round(performance.now() - began);
 const when = stoppedAt < timeout
  ? `after ${stoppedAt} ms (readiness budget ${timeout} ms)`
  : `within ${timeout} ms`;
 const message = `Owner entry ${entryName} did not become ready ${when}. Destination ${last}${diagnostics} No ready link was announced. ${log}Check startup output, then run the command again.`;
 const hint = "The seed's dev owner-entry route may lack the persona redeemer. See “Local dev identity and the key gate” in Base's operator-auth adoption guide (https://github.com/runeditrun/base/blob/main/modules/operator-auth/README.md#local-dev-identity-and-the-key-gate).";
 throw new RerError('owner_entry_not_ready', message, 1, persona && !result?.stopped && result?.exchanged === false ? { humanMessage: `${message} ${hint}` } : {});
}

async function runProbe(data, signal) {
 signal?.throwIfAborted();
 const worker = new Worker(new URL('./owner-entry-probe.mjs', import.meta.url), {
  workerData: data, stderr: true,
  env: { ...process.env, DEBUG: 'pw:browser', DEBUG_COLORS: '0', DEBUG_FILE: '' },
 });
 const lines = createInterface({ input: worker.stderr });
 let result, reason, exit;
 lines.on('line', line => {
  const status = /pw:browser \[pid=\d+\] <process did exit: exitCode=(-?\d+|null), signal=(SIG[A-Z0-9]+|null)>/.exec(line);
  if (status) exit = status[2] === 'null' ? `exit code ${status[1]}` : `signal ${status[2]}`;
  if (!reason && /pw:browser \[pid=\d+\]\s*\[err\]/.test(line)) {
   reason = [
    [/keychain/i, 'keychain error'],
    [/crashpad.*(?:failed|error)|--database is required/i, 'crash-reporting directory error'],
    [/no usable sandbox|sandbox initialization failed/i, 'sandbox initialization failed'],
    [/error while loading shared libraries/i, 'missing browser system library'],
    [/permission denied|EACCES/i, 'permission denied'],
    [/ENOENT|no such file or directory/i, 'browser file or executable missing'],
   ].find(([pattern]) => pattern.test(line))?.[1];
  }
 });
 const abort = () => worker.postMessage('cancel');
 signal?.addEventListener('abort', abort, { once: true });
 if (signal?.aborted) abort();
 try {
  await Promise.all([
   new Promise(resolve => { worker.on('message', value => { result = value; }); worker.on('error', () => { reason ??= 'browser probe worker failed'; }); worker.once('exit', resolve); }),
   new Promise(resolve => lines.once('close', resolve)),
  ]);
  return { result, browserExit: [exit, reason].filter(Boolean).join(', ') };
 } finally { signal?.removeEventListener('abort', abort); }
}
