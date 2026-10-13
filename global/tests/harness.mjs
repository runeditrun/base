// What the launcher journeys share: running a command, choosing a port, and
// finding (and ending) any process a launch left running in a checkout.
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// onStderr sees the command's progress lines as they arrive.
export function run(program, args, { onStderr, ...options } = {}) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; onStderr?.(String(data)); });
  child.once('error', reject);
  child.once('close', code => resolveRun({ code, stdout, stderr }));
 });
}

// A port nothing listens on. RER_TEST_PORTS=FROM-TO keeps a run inside a range.
export async function freePort() {
 const range = process.env.RER_TEST_PORTS?.match(/^(\d+)-(\d+)$/);
 for (const port of range ? Array.from({ length: range[2] - range[1] + 1 }, (_, i) => Number(range[1]) + i) : [0]) {
  const server = createServer();
  const bound = await new Promise(resolveListen => { server.once('error', () => resolveListen(false)); server.listen(port, '127.0.0.1', () => resolveListen(true)); });
  if (!bound) continue;
  const chosen = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return chosen;
 }
 throw new Error(`No free port in RER_TEST_PORTS=${process.env.RER_TEST_PORTS}.`);
}

// Processes (other than this one) whose command line names this path.
export async function processesIn(path) {
 const found = [];
 if (process.platform === 'linux') {
  for (const name of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
   let command;
   try { command = (await readFile(`/proc/${name}/cmdline`, 'utf8')).replaceAll('\0', ' '); } catch { continue; }
   if (command.includes(path) && Number(name) !== process.pid) found.push({ pid: Number(name), command });
  }
  return found;
 }
 const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
 for (const line of stdout.split('\n')) {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (match && match[2].includes(path) && Number(match[1]) !== process.pid) found.push({ pid: Number(match[1]), command: match[2] });
 }
 return found;
}

// End, by PID, whatever still runs in this path, and return what that was, so
// a journey that failed partway leaves no server behind and still says so.
export async function sweep(path) {
 const left = await processesIn(path);
 for (const { pid } of left) try { process.kill(pid, 'SIGTERM'); } catch {}
 if (left.length) await delay(3000);
 for (const { pid } of await processesIn(path)) try { process.kill(pid, 'SIGKILL'); } catch {}
 return left;
}
