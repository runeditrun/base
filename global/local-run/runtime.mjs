import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveServers } from '../registry.mjs';
import { ownRoot } from '../package-info.mjs';
import { resolveProject } from '../../cli/project.mjs';
import { run } from './process.mjs';
import { failure } from './error.mjs';

export async function runningApp(checkout) {
 const records = (await liveServers()).filter(record => resolve(record.checkout) === checkout);
 if (records.some(record => record.mode !== 'dev') || records.length > 1) throw failure('refused');
 return records[0] ?? null;
}
export async function verb(checkout, args, operation) {
 return run(process.execPath, [join(ownRoot, 'global/rer.mjs'), ...args, '--cwd', checkout], {
  cwd: checkout, env: operation ? { RER_LOCAL_OPERATION: operation.token } : {}, timeout: 600000,
 });
}
export async function stopApp(checkout, operation) {
 if (await runningApp(checkout)) await verb(checkout, ['dev', '--stop', '--json'], operation);
 if (await runningApp(checkout)) throw failure('stopped');
}
export async function startApp(checkout, operation) {
 try {
  const result = await verb(checkout, ['dev', '--detach', '--json'], operation);
  const events = result.stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const url = events.findLast(event => event.event === 'ready')?.url ?? (await runningApp(checkout))?.url;
  if (!url) throw failure('start_failed');
  return url;
 } catch (error) {
  // The checkout performs migration before it serves. Its error text stays
  // local; only the known startup failure token crosses the API boundary.
  throw error.error_code ? error : failure('start_failed');
 }
}
export async function health(checkout, origin) {
 const project = await resolveProject(checkout);
 const declared = project.adapter?.health;
 const path = typeof declared === 'string' ? declared : '/health';
 const base = new URL(origin), url = new URL(path, base);
 if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.hostname.endsWith('.localhost') || url.origin !== base.origin || url.username || url.password) throw failure('health_failed');
 const deadline = Date.now() + 120000;
 do {
  try {
   const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now()))) });
   await response.body?.cancel();
   if (response.ok) return;
  } catch { /* A startup can become ready during the bounded window. */ }
  if (Date.now() < deadline) await delay(Math.min(500, deadline - Date.now()));
 } while (Date.now() < deadline);
 throw failure('health_failed');
}
