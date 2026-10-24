import { Api, originUrl, identifier, pause } from './api.mjs';
import { paired } from './local-commands.mjs';
import { loadState } from './state.mjs';
import { publicTrust, trustKey, publicConfigPath, membershipPath, writePublicJson, removePublicJson } from './public-config.mjs';
import { checkout, sameSeed, appOrigins } from './sync-checkout.mjs';
import { materializeBusinessTrust } from '../local.mjs';
import { shared } from '../shared.mjs';
import { verifySettings } from './sync-document.mjs';
import { checkoutConnection, confirmConnection } from './sync-membership.mjs';

const fields = new Set(['display_name', 'owner_name', 'brand_color', 'timezone', 'logo', 'team']);
export const syncFailure = 'Business sync could not finish; the app keeps its current values. Run rer business sync when connected.';
const failed = (message, code = 'business_sync_failed') => Object.assign(Error(message), { businessSync: true, code });
const refused = error => error.status === 409 && error.reason === 'business_settings_not_adopted'
 ? 'This app does not take Business settings yet. Update the app, then run rer business sync.'
 : error.status === 404 ? 'This app is no longer available in Business. Check its app in Business, then run rer business sync --app ID.'
 : error.status === 401 ? 'Business pairing expired or was revoked. Run rer business connect --code CODE.'
 : 'Business sync is offline or the server did not answer. The app keeps its current values; run rer business sync when connected.';

async function pull({ app, seed, signal }) {
 if (!await loadState()) throw Object.assign(failed('This computer is not paired. Run rer business connect --code CODE.', 'business_not_paired'), { exitCode: 2 });
 const { state, credential } = await paired({ signal }).catch(error => {
  if (error.code === 'business_not_paired') throw Object.assign(failed('Business pairing is missing or incomplete. Run rer business disconnect, then rer business connect --code CODE.', 'business_not_paired'), { exitCode: 2 });
  throw error;
 });
 signal.throwIfAborted();
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

async function post(origins, document, signal, reloadOrigin) {
 const { appFetch } = await shared('app-fetch.mjs');
 for (const origin of origins) {
  // Only an explicit command that changed a running managed app's bindings
  // waits for its reload. Startup has no reloadOrigin: one POST, never a retry.
  const reloading = origin === reloadOrigin;
  do {
  let response;
  try { response = await appFetch(origin + '/api/rer/business-settings', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document), signal }); }
  catch {
   if (reloading) { if (await reloadPause(signal)) continue; break; }
   signal.throwIfAborted(); break;
  }
  if (response.status === 404) {
   await response.body?.cancel();
   if (reloading && await reloadPause(signal)) continue;
   break;
  }
  if (![200, 409].includes(response.status)) throw failed(`The app refused Business settings (HTTP ${response.status}). Its current values were kept.`);
  let ack;
  try { ack = await response.json(); } catch { throw failed('The app did not acknowledge Business settings.'); }
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
 const result = await pull({ app: app ?? connection.membership?.app, seed, signal });
 await confirmConnection(connection, result.state, result.app, { replace });
 signal.throwIfAborted();
 await writePublicJson(root, publicConfigPath, { [trustKey]: result.trust });
 await writePublicJson(root, membershipPath, { v: 1, app: result.app, seed, businessId: result.state.businessId, issuer: result.trust.issuer });
 const targets = origin ? { origins: [origin] } : await appOrigins(project);
 const changed = await materializeBusinessTrust(project);
 return post(targets.origins, result.document, signal, changed ? targets.reloadOrigin : undefined);
}

// One attempt per ready invocation, after the readiness line. The entire pull
// and post has a 3 s budget; no polling, retry loop or readiness dependency.
export async function syncOnReady(root, origin, report, membership) {
 try {
  if (!membership) return;
  report(await sync({ root, origin, app: identifier(membership.app), signal: AbortSignal.timeout(3000) }));
 } catch { report(syncFailure); }
}
