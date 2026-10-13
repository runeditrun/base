import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// The reviewed Beacon history is 216 MiB. A cold real-source acquisition
// exceeded 30 seconds locally; a measured warm acquisition took 23.6 seconds.
export const launchTimeoutMs = 60000;

// Failure-only inspection of the owned launcher tree. No environment or argv
// is collected: edition installers may receive credentials through stdin.
export async function launchDiagnostics(child, started, output, directory, timing = {}) {
 const read = path => readFile(path, 'utf8').catch(error => `unavailable: ${error.code}`);
 const processes = [];
 if (process.platform === 'linux') {
  const entries = await readdir('/proc').catch(() => []);
  const records = await Promise.all(entries.filter(pid => /^\d+$/.test(pid)).map(async pid => {
   const status = await read(`/proc/${pid}/status`);
   return { pid: Number(pid), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
    name: status.match(/^Name:\s+(.+)/m)?.[1], state: status.match(/^State:\s+(.+)/m)?.[1] };
  }));
  const owned = new Set([child.pid]);
  let count;
  do { count = owned.size; for (const record of records) if (owned.has(record.parent)) owned.add(record.pid); } while (count !== owned.size);
  for (const record of records.filter(record => owned.has(record.pid))) {
   processes.push({ ...record, wait: (await read(`/proc/${record.pid}/wchan`)).trim() });
  }
 }
 const sockets = process.platform === 'linux' ? Object.fromEntries(await Promise.all(['tcp', 'tcp6'].map(async protocol => {
  const table = await read(`/proc/net/${protocol}`);
  return [protocol, table.split('\n').filter((line, index) => index === 0 || line.trim().split(/\s+/)[3] === '0A')];
 }))) : { platform: process.platform };
 let installerLog, appLog;
 if (directory) {
  const state = await read(join(directory, '.seed/installer/state.json'));
  try { const parsed = JSON.parse(state); installerLog = { phase: parsed.phase, logs: parsed.logs }; }
  catch { installerLog = state; }
  appLog = (await read(join(directory, '.seed/installer/local-app.log'))).slice(-12000);
 }
 return JSON.stringify({ timestamp: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  child: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed },
  timing, processes, listeningSockets: sockets, installerLog, appLog, launcherLog: output }, null, 2);
}
