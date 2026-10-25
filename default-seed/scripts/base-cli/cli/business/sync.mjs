import { Api, originUrl, identifier, pause, readBody } from './api.mjs';
import { paired } from './local-commands.mjs';
import { loadState } from './state.mjs';
import { publicTrust, trustKey, publicConfigPath, membershipPath, writePublicJson, removePublicJson } from './public-config.mjs';
import { checkout, sameSeed, appOrigins } from './sync-checkout.mjs';
import { materializeBusinessTrust } from '../local.mjs';
import { shared } from '../shared.mjs';
import { verifySettings } from './sync-document.mjs';
import { checkoutConnection, confirmConnection, connectionDiffers, connectionRefusal } from './sync-membership.mjs';

const fields = new Set(['display_name', 'owner_name', 'brand_color', 'timezone', 'logo', 'team']);
// A trust change restarts the default seed's dev Worker: requests are held for
// about 5 s, then fail with 404 or 500, while health checks otherwise answer in
// under 0.4 s (measured on win-runner). A hold this long marks a restart, and
// one that went unseen has finished within restartMs.
const heldMs = 2000, restartMs = 10_000;
export const syncFailure = 'Business sync could not finish; the app keeps its current values. Run rer business sync when connected.';
export const trustFailure = 'Business trust in .rer/business-runtime.json could not be read, so the app runs without it and keeps its current values. Run rer business sync --leave, then rer business sync.';
const failed = (message, code = 'business_sync_failed') => Object.assign(Error(message), { businessSync: true, code });
const refused = error => error.status === 409 && error.code === 'business_settings_not_adopted'
 ? 'This app does not take Business settings yet. Update the app, then run rer business sync.'
 : error.status === 404 ? 'This app is no longer available in Business. Check its app in Business, then run rer business sync --app ID.'
 : error.status === 401 ? 'Business pairing expired or was revoked. Run rer business connect --code CODE.'
 : 'Business sync is offline or the server did not answer. The app keeps its current values; run rer business sync when connected.';

async function pull({ app, seed, signal, connection, replace }) {
 if (!await loadState()) throw Object.assign(failed('This computer is not paired. Run rer business connect --code CODE.', 'business_not_paired'), { exitCode: 2 });
 const { state, credential } = await paired({ signal }).catch(error => {
  if (error.code === 'business_not_paired') throw Object.assign(failed('Business pairing is missing or incomplete. Run rer business disconnect, then rer business connect --code CODE.', 'business_not_paired'), { exitCode: 2 });
  throw error;
 });
 signal.throwIfAborted();
 const changingBusiness = connectionDiffers(connection, state);
 if (changingBusiness && (!replace || !process.stdin.isTTY || !process.stderr.isTTY)) throw connectionRefusal();
 app ??= changingBusiness ? undefined : connection.membership?.app;
 const api = new Api(state.origin, credential);
 let result, chosen;
 try {
  const minted = await api.mintToken('mcp', { signal });
  const options = { token: minted.access_token, signal };
  const apps = await api.request('GET', '/api/business/executors/apps', undefined, options);
  if (!Array.isArray(apps)) throw Error('Invalid app list.');
  const candidates = apps.filter(item => item && ['self_host', 'self-host'].includes(item.hosting) && sameSeed(item.seed, seed));
  if (app) chosen = candidates.find(item => item.app === app);
  else if (candidates.length > 1) throw failed('More than one Business app matches this checkout. Run rer business sync --app ID.');
  else chosen = candidates[0];
  if (!chosen) throw failed(app ? 'That app does not match this checkout in the paired Business. Check the app id in Business, then run rer business sync --app ID.' : 'No self-host Business app matches this checkout. Add this edition in Business, then run rer business sync --app ID.', 'business_app_not_found');
  identifier(chosen.app);
  result = await api.request('GET', `/api/business/executors/apps/${encodeURIComponent(chosen.app)}/settings`, undefined, options);
 } catch (error) { throw error.businessSync ? error : failed(refused(error)); }
 signal.throwIfAborted();
 const trust = publicTrust(result?.trust);
 if (trust.issuer !== originUrl(state.origin) || trust.subject !== `${state.businessId}/${chosen.app}`
  || typeof result.settings !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.settings)
  || result.settings.length > 512_000 || result.logo !== null && (typeof result.logo !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.logo) || result.logo.length > 350_000)) throw failed('Business returned invalid settings. Nothing was saved.');
 const document = { settings: result.settings, ...(result.logo === null ? {} : { logo: result.logo }) };
 if (Buffer.byteLength(JSON.stringify(document)) > 512 * 1024) throw failed('Business settings exceed the app door limit. Nothing was saved.');
 await verifySettings(document, trust, state.businessId, result.trust.email);
 return { app: chosen.app, trust, document, state };
}

async function reloadPause(signal) {
 try { await pause(100, signal); return true; } catch { return false; }
}

function requestedRevision(settings) {
 try { return JSON.parse(Buffer.from(settings.split('.')[1], 'base64url').toString('utf8')).rev; }
 catch { return undefined; }
}

// After this run rewrote a running app's trust binding, Vite restarts its
// Worker: health checks are held, fail or are refused meanwhile. Wait, sending
// no document, until that restart was seen and health answers again; a restart
// that went unseen has had its time once restartMs has passed.
async function reloaded(origin, signal, appFetch) {
 const until = performance.now() + restartMs;
 let restarted = false;
 for (;;) {
  const started = performance.now();
  let healthy = false;
  try { const response = await appFetch(origin + '/health', { redirect: 'error', signal }); await response.body?.cancel(); healthy = response.ok; }
  catch { /* No answer while the Worker restarts. */ }
  if (signal.aborted) return false;
  if (!healthy || performance.now() - started >= heldMs) restarted = true;
  else if (restarted || performance.now() >= until) return true;
  if (!await reloadPause(signal)) return false;
 }
}

async function post({ origins, running }, document, signal, trustChanged) {
 const { appFetch } = await shared('app-fetch.mjs');
 for (const origin of origins) {
  // This checkout's registered dev server is waited for while its Worker
  // reloads, within the same budget. A 403 just after this run rewrote its
  // trust comes from the Worker that still holds the old trust: it is retried
  // once, after the reload. Startup and a deployed origin get one POST.
  const reloading = origin === running;
  let stale = reloading && trustChanged;
  do {
  let response;
  try { response = await appFetch(origin + '/api/rer/business-settings', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document), signal }); }
  catch {
   if (reloading) { if (await reloadPause(signal)) continue; throw failed('The app did not finish reloading Business settings. Run rer business sync again.'); }
   signal.throwIfAborted(); break;
  }
  // The running app answers 404 or a proxy error while its Worker restarts.
  if (response.status === 404 || reloading && [500, 502, 503, 504].includes(response.status)) {
   const status = response.status;
   await response.body?.cancel();
   if (!reloading) break;
   if (await reloadPause(signal)) continue;
   throw failed(`The app did not finish reloading Business settings (HTTP ${status}). Run rer business sync again.`);
  }
  if (response.status === 403 && stale) {
   stale = false;
   await response.body?.cancel();
   if (await reloaded(origin, signal, appFetch)) continue;
  }
  if (![200, 409].includes(response.status)) throw failed(`The app refused Business settings (HTTP ${response.status}). Its current values were kept.`);
  let ack;
  try { ack = JSON.parse((await readBody(response, signal, 1_000_000)).text); } catch { throw failed('The app did not acknowledge Business settings.'); }
  if (!Number.isSafeInteger(ack?.rev) || ack.rev < 1 || !Array.isArray(ack.applied) || !ack.applied.every(field => fields.has(field))) throw failed('The app returned an invalid Business acknowledgement.');
  // An equal-revision ack also covers a successful apply whose response was
  // lost during reload. The app verified the signature and remains authority.
  if (response.status === 409 && ack.rev === requestedRevision(document.settings)) return `Business settings rev ${ack.rev} already applied: ${ack.applied.join(', ') || 'no fields'} (HTTP 409).`;
  return response.status === 409 ? `Business settings rev ${ack.rev} kept; the app refused a stale revision (HTTP 409).`
   : `Business settings rev ${ack.rev} applied: ${ack.applied.join(', ') || 'no fields'}.`;
  } while (reloading && !signal.aborted);
 }
 return 'Business settings saved; start the app with rer dev to apply.';
}

export async function sync({ root = process.cwd(), app, leave = false, replace = false, origin, signal = AbortSignal.timeout(30_000) } = {}) {
 const { project, seed } = await checkout(root);
 if (leave) {
  await removePublicJson(root, membershipPath);
  await removePublicJson(root, publicConfigPath);
  await materializeBusinessTrust(project, { leave: true });
  return 'Business settings disconnected; the app keeps its current values.';
 }
 const connection = await checkoutConnection(root);
 const result = await pull({ app, seed, signal, connection, replace });
 await confirmConnection(connection, result.state, result.app, { replace });
 signal.throwIfAborted();
 await writePublicJson(root, publicConfigPath, { [trustKey]: result.trust });
 await writePublicJson(root, membershipPath, { v: 1, app: result.app, seed, businessId: result.state.businessId, issuer: result.trust.issuer });
 const targets = origin ? { origins: [origin] } : await appOrigins(project);
 return post(targets, result.document, signal, await materializeBusinessTrust(project));
}

// One attempt per ready invocation, after the readiness line. The entire pull
// and post has a 3 s budget; no polling, retry loop or readiness dependency.
export async function syncOnReady(root, origin, report, membership) {
 try {
  if (!membership) return;
  report(await sync({ root, origin, app: identifier(membership.app), signal: AbortSignal.timeout(3000) }));
 } catch { report(syncFailure); }
}
