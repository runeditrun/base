import { setTimeout as pause } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { checkoutPlaywright, ensureChromium, browsersPresent } from './browser-runtime.mjs';
import { invalid, missing, RerError } from './errors.mjs';

const browserSetupTimeout = 300000;

// Use the browser protocol itself: fragment exchange, cookies, server and
// client redirects, and rendered content. No application destination is fixed.
export async function ownerEntryReady(root, link, signal, store, { persona = false, startupLog = store?.logPath } = {}) {
 // A freshly started dev server can still be compiling its first client
 // module graph. A reattach only checks an already running application.
 const timeout = Number(process.env.RER_OWNER_READY_TIMEOUT_MS ?? (store ? 180000 : 60000));
 if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw invalid('RER_OWNER_READY_TIMEOUT_MS must be positive integer milliseconds, at most 2147483647.');
 const browserHome = process.env.RER_OWNER_BROWSER_HOME;
 if (browserHome !== undefined && (!isAbsolute(browserHome) || !(await stat(browserHome).catch(() => null))?.isDirectory())) {
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
 const { playwright } = checkoutPlaywright(root);
 const entry = new URL(link), deadline = performance.now() + timeout;
 const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
 let browser, page, lastState, destination = entry, last = 'browser did not open the entry', documents = 0, status, exchanged = !entry.hash, lastReload = 0;
 let personaExchangeMissing = false;
 const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
 const name = url => url.origin + url.pathname; // Fragments and query values may be credentials.
 const close = () => { void browser?.close().catch(() => {}); };
 bounded.addEventListener('abort', close, { once: true });
 try {
  bounded.throwIfAborted();
  browser = await playwright.chromium.launch({
   headless: true, timeout: remaining(),
   ...(browserHome === undefined ? {} : { env: { ...process.env, HOME: browserHome } }),
   args: ['--use-mock-keychain', '--password-store=basic'],
  });
  bounded.throwIfAborted();
  const context = await browser.newContext();
  page = await context.newPage();
  // An owner credential and its cookies must never travel to another origin.
  await context.route('**/*', route => {
   const url = new URL(route.request().url());
   return url.origin === entry.origin || !['http:', 'https:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  page.on('response', response => {
   const request = response.request();
   if (request.method() === 'POST' && new URL(response.url()).pathname === entry.pathname && response.ok()) exchanged = true;
   if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
    documents++; status = response.status(); destination = new URL(response.url());
   }
  });
  try { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: Math.min(5000, remaining()) }); } catch { last = 'entry document did not finish loading'; }
  while (!bounded.aborted && browser.isConnected()) {
   destination = new URL(page.url() === 'about:blank' ? entry.href : page.url());
   const state = await page.evaluate(() => {
    const visible = element => !!(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const area = document.querySelector('main') ?? document.body, text = area?.innerText.trim() ?? '';
    const retry = /the workspace is busy|trying again in a few seconds/i.test(text);
    const loading = [...area?.querySelectorAll('[role="status"]') ?? []].some(element => visible(element) && /^loading\b/i.test(element.innerText.trim()));
    const busy = retry || loading || [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible) || /^loading[.\s…]*$/i.test(text);
    // An owner destination may be a read-only status page. Its controls may
    // also live outside the light DOM; visible rendered content is enough,
    // provided all exchange, navigation and interstitial checks below pass.
    const usable = !!text && !!area && visible(area);
    return { busy, retry, usable, refresh: !!document.querySelector('meta[http-equiv="refresh" i]') };
   }).catch(() => null); // A navigation can replace the execution context.
   if (state) lastState = { ...state, status };
   // Retain observations for diagnostics only. Readiness still requires a
   // successful read of the current document, never a cached usable page.
   const observed = lastState;
   const conditions = [
    observed && !observed.usable && 'no rendered owner content',
    observed?.busy && 'busy/retry interstitial',
    observed?.refresh && 'refresh interstitial',
   ].filter(Boolean);
   const failed = [
    !exchanged && 'entry exchange not observed',
    entry.hash && documents <= 1 && 'destination document not observed after entry',
    !(status >= 200 && status < 300) && 'destination status is not 2xx',
    !state && (observed ? 'destination DOM could not be read again' : 'destination DOM unavailable'),
    ...conditions,
    destination.hash && 'destination still has a fragment',
    destination.origin !== entry.origin && 'destination is cross-origin',
   ].filter(Boolean);
   personaExchangeMissing = persona && !exchanged;
   last = `HTTP ${status ?? 'unknown'} (${failed.join('; ')}). Readiness: exchanged=${exchanged}, documents=${documents}, usable=${observed?.usable ?? 'unknown'}, busy=${observed?.busy ?? 'unknown'}, refresh=${observed?.refresh ?? 'unknown'}, fragment=${!!destination.hash}, sameOrigin=${destination.origin === entry.origin}`;
   if (observed) last += `. Last seen: HTTP ${observed.status ?? 'unknown'} (${conditions.join('; ') || 'rendered owner content'})`;
   if (!failed.length) return;
   // A server interstitial needs another GET. Client navigation/loading gets
   // time to finish on its own rather than being restarted on every poll.
   if (status && (status >= 400 || state?.retry || state?.refresh) && performance.now() - lastReload > 1000) {
    lastReload = performance.now();
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(5000, remaining()) }); } catch { last += '; the next destination document did not finish loading'; }
   }
   await pause(Math.min(100, remaining()), undefined, { signal: bounded }).catch(() => {});
  }
 } catch (error) {
  signal?.throwIfAborted();
  if (error instanceof RerError && !bounded.aborted) throw error;
 } finally {
  if (!bounded.aborted && !browser?.isConnected()) {
   last += '. Headless Chromium could not stay open. If Chromium must run outside the installer HOME, set RER_OWNER_BROWSER_HOME to its permitted home directory';
  }
  bounded.removeEventListener('abort', close);
  await browser?.close().catch(() => {});
 }
 signal?.throwIfAborted();
 const message = `Owner entry ${name(entry)} did not become ready within ${timeout} ms. Destination ${name(destination)}: ${last}. No ready link was announced. ${log}Check startup output, then run the command again.`;
 const hint = "The seed's dev owner-entry route may lack the persona redeemer. See “Local dev identity and the key gate” in Base's operator-auth adoption guide (https://github.com/runeditrun/base/blob/main/modules/operator-auth/README.md#local-dev-identity-and-the-key-gate).";
 throw new RerError('owner_entry_not_ready', message, 1, personaExchangeMissing ? { humanMessage: `${message} ${hint}` } : {});
}
