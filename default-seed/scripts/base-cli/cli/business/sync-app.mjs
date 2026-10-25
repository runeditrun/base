import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pause, readBody } from './api.mjs';
import { shared } from '../shared.mjs';

const fields = new Set(['display_name', 'owner_name', 'brand_color', 'timezone', 'logo', 'team']);
// The default seed's dev Worker restarts after every change to its local
// runtime settings (.dev.vars): health checks are held for about 5 s, then
// fail, while they otherwise answer in under 0.4 s (measured on win-runner). A
// restart shows within 0.3 s of the change (startMs allows for a busy
// machine), and a second change inside it stops rer dev. One that has not
// shown within restartMs of this run's change is not coming.
const heldMs = 2000, startMs = 2000, restartMs = 10_000;
export const failed = (message, code = 'business_sync_failed') => Object.assign(Error(message), { businessSync: true, code });
const unfinished = () => failed('The app did not finish reloading Business settings. Run rer business sync again.');

async function reloadPause(signal) {
 try { await pause(100, signal); return true; } catch { return false; }
}

// Polls /health until it answers promptly, then says whether a restart was
// seen meanwhile (a check held, failed or refused). Before `until` a prompt
// answer counts only after a restart. Null once the budget ends.
async function settled(origin, signal, until = 0) {
 const { appFetch } = await shared('app-fetch.mjs');
 let restarted = false;
 for (;;) {
  const started = performance.now();
  let healthy = false;
  try { const response = await appFetch(origin + '/health', { redirect: 'error', signal }); await response.body?.cancel(); healthy = response.ok; }
  catch { /* No answer while the Worker restarts. */ }
  if (signal.aborted) return null;
  if (!healthy || performance.now() - started >= heldMs) restarted = true;
  else if (restarted || performance.now() >= until) return restarted;
  if (!await reloadPause(signal)) return null;
 }
}

// Before this run changes the running app's settings file or posts to it, a
// restart in flight is waited out; a change younger than startMs may not show
// its restart yet.
export async function quiet(project, running, signal) {
 if (!running) return;
 let changed = 0;
 try { changed = (await stat(resolve(project.root, project.adapter.hooks.secrets.file ?? '.dev.vars'))).mtimeMs; }
 catch (error) { if (error.code !== 'ENOENT') throw error; }
 if (await settled(running, signal, performance.now() + changed + startMs - Date.now()) === null) throw failed('The app is still restarting, so nothing was changed. Run rer business sync again once it answers.');
}

// After this run changed the settings file: wait for the restart it starts,
// so the next change or POST reaches the new Worker.
export async function reloaded(running, signal) {
 return await settled(running, signal, performance.now() + restartMs) !== null;
}

function requestedRevision(settings) {
 try { return JSON.parse(Buffer.from(settings.split('.')[1], 'base64url').toString('utf8')).rev; }
 catch { return undefined; }
}

async function send(origin, document, signal) {
 const { appFetch } = await shared('app-fetch.mjs'), started = performance.now();
 try {
  const response = await appFetch(origin + '/api/rer/business-settings', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document), signal });
  return { response, held: performance.now() - started >= heldMs };
 } catch { signal.throwIfAborted(); return {}; }
}

// The document goes to the running app, then to a recorded deployment, and
// the first acknowledgement is the result. The running app was quiet when
// posting began. If a restart still gets in the way there (no answer, a 5xx
// or 404 while health is down, or a request it held), the document goes once
// more after it. A 404 while health answers promptly is the app's own: it
// takes no settings. The startup pull (wait false) posts once.
export async function post({ origins, running }, document, signal, { wait = true } = {}) {
 let declined = false;
 for (const origin of origins) {
  let { response, held } = await send(origin, document, signal);
  if (origin === running && wait && (!response || response.status === 404 || response.status >= 500)) {
   await response?.body?.cancel();
   const restarted = await settled(origin, signal);
   if (restarted === null) throw unfinished();
   if (restarted || held || !response) ({ response } = await send(origin, document, signal));
  }
  if (!response) continue;
  if (response.status === 404) { await response.body?.cancel(); declined ||= origin === running; continue; }
  if (![200, 409].includes(response.status)) throw failed(`The app refused Business settings (HTTP ${response.status}). Its current values were kept.`);
  let ack;
  try { ack = JSON.parse((await readBody(response, signal, 1_000_000)).text); } catch { throw failed('The app did not acknowledge Business settings.'); }
  if (!Number.isSafeInteger(ack?.rev) || ack.rev < 1 || !Array.isArray(ack.applied) || !ack.applied.every(field => fields.has(field))) throw failed('The app returned an invalid Business acknowledgement.');
  // An equal-revision ack also covers a successful apply whose response was
  // lost during reload. The app verified the signature and remains authority.
  if (response.status === 409 && ack.rev === requestedRevision(document.settings)) return `Business settings rev ${ack.rev} already applied: ${ack.applied.join(', ') || 'no fields'} (HTTP 409).`;
  return response.status === 409 ? `Business settings rev ${ack.rev} kept; the app refused a stale revision (HTTP 409).`
   : `Business settings rev ${ack.rev} applied: ${ack.applied.join(', ') || 'no fields'}.`;
 }
 return declined ? 'Business settings saved, but the running app does not take them (its Business settings were stopped or are not set up), so it keeps its current values.'
  : 'Business settings saved; start the app with rer dev to apply.';
}
