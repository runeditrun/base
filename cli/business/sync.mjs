import { Api, originUrl, identifier } from './api.mjs';
import { paired } from './local-commands.mjs';
import { loadState } from './state.mjs';
import { publicTrust, trustKey, publicConfigPath, membershipPath, readPublicJson, writePublicJson, removePublicJson } from './public-config.mjs';
import { checkout, sameSeed, appOrigins } from './sync-checkout.mjs';
import { materializeBusinessTrust } from '../local.mjs';
import { shared } from '../shared.mjs';

const fields = new Set(['display_name', 'owner_name', 'brand_color', 'timezone', 'logo', 'team']);
const failed = message => Object.assign(Error(message), { businessSync: true });
const refused = error => error.status === 409 && error.reason === 'business_settings_not_adopted'
 ? 'This app does not take Business settings yet. Update the app, then run rer business sync.'
 : error.status === 404 ? 'This app is no longer available in Business. Check its app in Business, then run rer business sync --app ID.'
 : error.status === 401 ? 'Business pairing expired or was revoked. Run rer business connect --code CODE.'
 : 'Business sync is offline or the server did not answer. The app keeps its current values; run rer business sync when connected.';

async function pull({ app, seed, signal }) {
 if (!await loadState()) throw Object.assign(failed('This computer is not paired. Run rer business connect --code CODE.'), { exitCode: 2 });
 const { state, credential } = await paired({ signal });
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
  if (!chosen) throw failed('No self-host Business app matches this checkout. Add this edition in Business, then run rer business sync --app ID.');
  identifier(chosen.app);
  result = await api.request('GET', `/api/business/executors/apps/${encodeURIComponent(chosen.app)}/settings`, undefined, options);
 } catch (error) { throw error.businessSync ? error : failed(refused(error)); }
 signal.throwIfAborted();
 const trust = publicTrust(result?.trust);
 if (trust.issuer !== originUrl(state.origin) || trust.subject !== `${state.businessId}/${chosen.app}`
  || typeof result.settings !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.settings)
  || result.settings.length > 512_000 || result.logo !== null && (typeof result.logo !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.logo) || result.logo.length > 350_000)) throw failed('Business returned invalid settings. Nothing was saved.');
 const document = { settings: result.settings, logo: result.logo };
 if (Buffer.byteLength(JSON.stringify(document)) > 512 * 1024) throw failed('Business settings exceed the app door limit. Nothing was saved.');
 return { app: chosen.app, trust, document };
}

async function post(origins, document, signal) {
 const { appFetch } = await shared('app-fetch.mjs');
 for (const origin of origins) {
  let response;
  try { response = await appFetch(origin + '/api/rer/business-settings', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document), signal }); }
  catch { signal.throwIfAborted(); continue; }
  if (response.status === 404) continue;
  if (![200, 409].includes(response.status)) throw failed(`The app refused Business settings (HTTP ${response.status}). Its current values were kept.`);
  let ack;
  try { ack = await response.json(); } catch { throw failed('The app did not acknowledge Business settings.'); }
  if (!Number.isSafeInteger(ack?.rev) || ack.rev < 1 || !Array.isArray(ack.applied) || !ack.applied.every(field => fields.has(field))) throw failed('The app returned an invalid Business acknowledgement.');
  return response.status === 409 ? `Business settings rev ${ack.rev} kept; the app refused a stale revision (HTTP 409).`
   : `Business settings rev ${ack.rev} applied: ${ack.applied.join(', ') || 'no fields'}.`;
 }
 return 'Business settings saved; start the app with rer dev to apply.';
}

export async function sync({ root = process.cwd(), app, leave = false, origin, signal = AbortSignal.timeout(3000) } = {}) {
 const { project, seed } = await checkout(root);
 if (leave) {
  await removePublicJson(root, membershipPath);
  await removePublicJson(root, publicConfigPath);
  await materializeBusinessTrust(project, { leave: true });
  return 'Business settings disconnected; the app keeps its current values.';
 }
 const result = await pull({ app, seed, signal });
 signal.throwIfAborted();
 await writePublicJson(root, publicConfigPath, { [trustKey]: result.trust });
 await writePublicJson(root, membershipPath, { v: 1, app: result.app, seed });
 await materializeBusinessTrust(project);
 return post(origin ? [origin] : await appOrigins(project), result.document, signal);
}

// One attempt per ready invocation, after the readiness line. The entire pull
// and post has a 3 s budget; no polling, retry loop or readiness dependency.
export async function syncOnReady(root, origin, report) {
 try {
  const membership = await readPublicJson(root, membershipPath);
  if (!membership) return;
  report(await sync({ root, origin, app: identifier(membership.app) }));
 } catch { report('Business sync could not finish; the app keeps its current values. Run rer business sync when connected.'); }
}
