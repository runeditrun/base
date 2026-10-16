import { homedir } from 'node:os';
import { join } from 'node:path';
import { Api, originUrl, identifier, pause } from './api.mjs';
import { loadState, saveState, credentialHandle } from './state.mjs';
import { createCredentialStore } from './keychain.mjs';
import { installService } from './service.mjs';
import { installPermissions } from './permissions.mjs';
import { consent } from './prompts.mjs';

export const capabilities = ['discover.local', 'export.vendor:sentry', 'export.vendor:uptimerobot', 'export.vendor:pagerduty', 'export.vendor:calendly'];

export async function connect({ code, origin }) {
 origin = originUrl(origin);
 if (await loadState()) throw Error('Business has local pairing state. Disconnect before pairing again.');
 const store = createCredentialStore(), handle = credentialHandle(origin);
 // Fail before redeeming the one-use browser code if the OS store is absent.
 if (await store.get(handle)) throw Error('A Business credential already exists for this origin. Disconnect it before pairing again.');
 const api = new Api(origin);
 const pending = await api.post('/api/business/executors/pair', {
  code, os: process.platform === 'darwin' ? 'macos' : 'linux', agent_kind: 'other', capabilities,
 });
 if (pending.status !== 'pending_approval' || !/^\d{6}$/.test(pending.confirmation_number) || typeof pending.pairing_token !== 'string') throw Error('Business server returned an invalid pairing response.');
 process.stdout.write(`Confirmation number: ${pending.confirmation_number}\nCompare this number in the browser that created the code, then approve. Waiting for browser approval.\n`);
 const expires = Math.min(Date.now() + 600_000, Date.parse(pending.expires_at));
 if (!Number.isFinite(expires)) throw Error('Business server returned an invalid pairing expiry.');
 let result;
 while (Date.now() < expires) {
  result = await api.post('/api/business/executors/pair', { pairing_token: pending.pairing_token });
  if (result.status === 'paired') break;
  if (result.status !== 'authorization_pending') throw Error('Business server returned an invalid pairing status.');
  await pause(Math.max(1, Math.min(5, Number(result.interval) || 5)) * 1000);
 }
 if (result?.status !== 'paired' || typeof result.device_credential !== 'string') throw Error('Browser approval expired. Create a new pairing code in the browser.');
 const state = { version: 1, origin, businessId: identifier(result.business_id), executorId: identifier(result.executor_id), vendorHandles: [], awakeConsent: false };
 await store.set(handle, result.device_credential);
 try { await saveState(state); } catch (error) { await store.delete(handle); throw error; }
 process.stdout.write('Business paired. Device credential stored in OS keychain.\n');
 if (await consent('Add secret-file Read deny rules to Claude Code user settings?')) await installPermissions({ consent: true });
 if (process.platform === 'darwin') state.awakeConsent = await consent('Keep this Mac awake only while an export task lease is active?');
 await saveState(state);
 if (await consent('Install a user background service running rer business run after this chat?')) {
  await installService({ consent: true });
  process.stdout.write('Business background service installed.\n');
 } else process.stdout.write('Run rer business run in a terminal to work tasks.\n');
}

export function localRoot(path) {
 if (typeof path !== 'string' || !path || path.includes('\0')) throw Error('Task has an invalid consented scan root.');
 return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
