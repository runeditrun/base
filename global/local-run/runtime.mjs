import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { localOperation } from '../../onboarding/local/operation.mjs';
import { processStart } from '../../onboarding/local/process-table.mjs';
import { liveServers } from '../registry.mjs';
import { ownRoot } from '../package-info.mjs';
import { dispatcher } from '../checkout.mjs';
import { resolveProject } from '../../cli/project.mjs';
import { run } from './process.mjs';
import { failure } from './error.mjs';

export async function runningApp(checkout) {
 const records = (await liveServers()).filter(record => resolve(record.checkout) === checkout);
 if (records.some(record => record.mode !== 'dev') || records.length > 1) throw failure('refused');
 return records[0] ?? null;
}
// Use the pinned dispatcher's existing authenticated management transport. Old
// servers have no advertised handoff and are refused before stop or state edits.
function management(record, action) {
 return new Promise((resolveRequest, reject) => {
  const socket = createConnection(record.control); let bytes = '';
  socket.setTimeout(10000, () => socket.destroy(failure('refused')));
  socket.on('connect', () => socket.end(JSON.stringify({ token: record.token, checkout: record.checkout, generation: record.generation, action })));
  socket.on('data', chunk => { bytes += chunk; if (bytes.length > 16384) socket.destroy(failure('refused')); });
  socket.on('error', reject);
  socket.on('end', () => {
   try {
    const result = JSON.parse(bytes);
    if (result.token !== record.token || result.checkout !== record.checkout || result.generation !== record.generation) throw failure('refused');
    resolveRequest(result);
   } catch { reject(failure('refused')); }
  });
 });
}
export async function acquireOperation(checkout, beforeHandoff = async () => {}) {
 const selected = dispatcher(checkout);
 const module = resolve(dirname(selected.entry), selected.mode === 'vendored' ? 'base-cli/cli/managed-server.mjs' : '../cli/managed-server.mjs');
 if ((await import(pathToFileURL(module).href)).operationHandoff !== 1) {
  throw failure('refused', 'This checkout pins a rer version without upgrade ownership handoff. Its app and data were left in place. Adopt a rer release with handoff support in the checkout before upgrading.');
 }
 try {
  const operation = await localOperation(checkout);
  try { await beforeHandoff(); return operation; }
  catch (error) { await operation.release(); throw error; }
 }
 catch (error) {
  if (error.code !== 'LOCAL_OPERATION_BUSY') throw error;
  const record = await runningApp(checkout);
  if (!record || record.owner?.pid !== error.ownerPid) throw error;
  let status;
  try { status = await management(record, 'status'); } catch { /* Old protocol or unreachable control: refuse without mutation. */ }
  if (status?.operationHandoff !== 1) {
   throw failure('refused', 'This running app uses a rer version without upgrade ownership handoff. Stop it with rer dev --stop in this checkout, then install a release with handoff support before upgrading.');
  }
  await beforeHandoff();
  const target = { pid: process.pid, start: await processStart(process.pid) };
  const reply = await management(record, 'operation-handoff:' + Buffer.from(JSON.stringify(target)).toString('base64url'));
  return localOperation(checkout, reply.operationToken, { adopt: true });
 }
}
export async function returnOperation(checkout, operation) {
 const record = await runningApp(checkout);
 if (!record) return;
 if ((await management(record, 'status')).operationHandoff !== 1) throw failure('refused');
 await operation.handoff({ pid: record.owner.pid, start: await processStart(record.owner.pid) });
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
