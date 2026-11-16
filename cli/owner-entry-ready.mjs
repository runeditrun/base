import { setTimeout as pause } from 'node:timers/promises';
import { checkoutPlaywright, ensureChromium, browsersPresent } from './browser-runtime.mjs';
import { invalid, missing, RerError } from './errors.mjs';

// Use the browser protocol itself: fragment exchange, cookies, server and
// client redirects, and rendered content. No application destination is fixed.
export async function ownerEntryReady(root, link, signal, store) {
 const timeout = Number(process.env.RER_OWNER_READY_TIMEOUT_MS ?? 60000);
 if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw invalid('RER_OWNER_READY_TIMEOUT_MS must be positive integer milliseconds, at most 2147483647.');
 if (store) await ensureChromium(root, store, signal);
 else if (!await browsersPresent(root)) throw missing('Owner entry verification needs the checkout’s headless browser. Run rer verify to provision it, then run the command again.');
 const { playwright } = checkoutPlaywright(root), entry = new URL(link), deadline = performance.now() + timeout;
 const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
 let browser, page, destination = entry, last = 'browser did not open the entry', documents = 0, status, exchanged = !entry.hash, lastReload = 0;
 const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
 const name = url => url.origin + url.pathname; // Fragments and query values may be credentials.
 const close = () => { void browser?.close().catch(() => {}); };
 bounded.addEventListener('abort', close, { once: true });
 try {
  browser = await playwright.chromium.launch({ headless: true, timeout: remaining(), args: ['--use-mock-keychain', '--password-store=basic'] });
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
  while (!bounded.aborted) {
   destination = new URL(page.url() === 'about:blank' ? entry.href : page.url());
   const state = await page.evaluate(() => {
    const visible = element => !!(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const area = document.querySelector('main') ?? document.body, text = area?.innerText.trim() ?? '';
    const retry = /the workspace is busy|trying again in a few seconds/i.test(text);
    const busy = retry || [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible) || /^loading[.\s…]*$/i.test(text);
    const usable = !!text && [...(area?.querySelectorAll('input,button,a[href],select,textarea') ?? [])].some(element => visible(element) && !element.disabled);
    return { busy, retry, usable, refresh: !!document.querySelector('meta[http-equiv="refresh" i]') };
   }).catch(() => null); // A navigation can replace the execution context.
   if (state?.busy || state?.refresh) last = `HTTP ${status ?? 'unknown'} (busy/retry interstitial)`;
   else last = `HTTP ${status ?? 'unknown'} (no usable owner page)`;
   if (exchanged && (!entry.hash || documents > 1) && status >= 200 && status < 300 && state?.usable && !state.busy && !state.refresh && !destination.hash && destination.origin === entry.origin) return;
   // A server interstitial needs another GET. Client navigation/loading gets
   // time to finish on its own rather than being restarted on every poll.
   if (status && (status >= 400 || state?.retry || state?.refresh) && performance.now() - lastReload > 1000) {
    lastReload = performance.now();
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(5000, remaining()) }); } catch { last = 'destination document did not finish loading'; }
   }
   await pause(Math.min(100, remaining()), undefined, { signal: bounded }).catch(() => {});
  }
 } catch {
  signal?.throwIfAborted();
 } finally {
  bounded.removeEventListener('abort', close);
  await browser?.close();
 }
 signal?.throwIfAborted();
 throw new RerError('owner_entry_not_ready', `Owner entry ${name(entry)} did not become ready within ${timeout} ms. Destination ${name(destination)}: ${last}. No ready link was announced. Check the application startup log, then run the command again.`, 1);
}
