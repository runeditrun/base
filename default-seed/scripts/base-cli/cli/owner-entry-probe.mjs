import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as pause } from 'node:timers/promises';
import { checkoutPlaywright } from './browser-runtime.mjs';

// This worker keeps Playwright's browser process logging out of the command's
// output. The parent extracts exit status and known causes from its stderr.
const cancellation = new AbortController();
parentPort.once('message', () => cancellation.abort());
try { parentPort.postMessage(await probe(workerData, cancellation.signal)); }
finally { parentPort.close(); }

async function probe({ root, link, timeout, browserHome }, signal) {
 const { playwright } = checkoutPlaywright(root);
 const entry = new URL(link), deadline = performance.now() + timeout;
 const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
 let browser, page, lastState, destination = entry, last = 'browser did not open the entry', documents = 0, status, exchanged = !entry.hash, lastReload = 0;
 let phase = 'launch', stopped, observedAt, exchangeStatus, pageErrors = 0, failedAssets = 0, httpAssetErrors = 0;
 const elapsed = () => Math.round(performance.now() - (deadline - timeout));
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
  phase = 'opening a browser page';
  bounded.throwIfAborted();
  const context = await browser.newContext();
  page = await context.newPage();
  page.on('crash', () => { stopped = 'Chromium renderer crashed'; });
  page.on('pageerror', () => { pageErrors++; });
  const clientAsset = request => ['script', 'stylesheet'].includes(request.resourceType());
  page.on('requestfailed', request => { if (clientAsset(request)) failedAssets++; });
  // An owner credential and its cookies must never travel to another origin.
  await context.route('**/*', route => {
   const url = new URL(route.request().url());
   return url.origin === entry.origin || !['http:', 'https:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  page.on('response', response => {
   const request = response.request();
   const responseUrl = new URL(response.url());
   if (response.status() >= 400 && clientAsset(request)) httpAssetErrors++;
   if (request.method() === 'POST' && responseUrl.origin === entry.origin && responseUrl.pathname === entry.pathname) {
    exchangeStatus = response.status();
    if (response.ok()) exchanged = true;
   }
   if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
    documents++; status = response.status(); destination = new URL(response.url());
   }
  });
  phase = 'loading the entry';
  try { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: Math.min(5000, remaining()) }); } catch { last = 'entry document did not finish loading'; }
  if (browser.isConnected()) phase = 'waiting for the owner page to render';
  while (!stopped && !bounded.aborted && browser.isConnected()) {
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
    return { busy, retry, usable, readyState: document.readyState, scripts: document.scripts.length, refresh: !!document.querySelector('meta[http-equiv="refresh" i]') };
   }).catch(() => null); // A navigation can replace the execution context.
   if (state) lastState = { ...state, status, elapsed: elapsed() };
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
   last = `HTTP ${status ?? 'unknown'} (${failed.join('; ')}). Readiness: exchanged=${exchanged}, documents=${documents}, usable=${observed?.usable ?? 'unknown'}, busy=${observed?.busy ?? 'unknown'}, refresh=${observed?.refresh ?? 'unknown'}, fragment=${!!destination.hash}, sameOrigin=${destination.origin === entry.origin}`;
   if (observed) last += `. Last seen: HTTP ${observed.status ?? 'unknown'} (${conditions.join('; ') || 'rendered owner content'})`;
   if (!failed.length && !stopped && !bounded.aborted && browser.isConnected()) return { ready: true };
   // A server interstitial needs another GET. Client navigation/loading gets
   // time to finish on its own rather than being restarted on every poll.
   if (status && (status >= 400 || state?.retry || state?.refresh) && performance.now() - lastReload > 1000) {
    lastReload = performance.now();
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(5000, remaining()) }); } catch { last += '; the next destination document did not finish loading'; }
   }
   await pause(Math.min(100, remaining()), undefined, { signal: bounded }).catch(() => {});
  }
 } catch {
  // The Chromium process log is collected by the caller. Playwright's call
  // errors may contain the private owner link, so only report the failed phase.
 } finally {
  if (!stopped && !bounded.aborted && !browser?.isConnected()) stopped = browser ? 'Chromium disconnected' : 'Chromium launch failed';
  observedAt = elapsed();
  bounded.removeEventListener('abort', close);
  await browser?.close().catch(() => {});
 }
 signal.throwIfAborted();
 const client = `Phase: ${phase}. Exchange HTTP ${exchangeStatus ?? 'unobserved'}. Client: ${lastState?.readyState ?? 'unobserved'} document, scripts=${lastState?.scripts ?? 'unknown'}, pageErrors=${pageErrors}, failedAssets=${failedAssets}, httpAssetErrors=${httpAssetErrors}${lastState ? `, last DOM read at ${lastState.elapsed} ms` : ''}`;
 return { destination: name(destination), last, client, stopped, observedAt, exchanged };
}
