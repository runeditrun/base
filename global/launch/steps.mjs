// Run the pinned dispatcher's public verbs as children, reading its --json
// events: install and setup to completion, and dev until its `ready` event.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { LaunchFailure } from './failure.mjs';

function events(line) { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : undefined; } catch { return undefined; } }

// What a child's JSON event means for the person waiting.
export function waitingNote(event) {
 if (event.event === 'waiting') return `waiting in the job queue${event.reason ? `: ${event.reason}` : ''}`;
 if (event.event === 'node-selection') return event.message;
 if (event.event === 'port') return `using port ${event.port}`;
 return undefined;
}

export function failureFrom(code, error, output) {
 return new LaunchFailure(code || 1, error?.message ?? (output.trim().split('\n').slice(-5).join('\n') || `The command stopped with exit ${code}.`), error);
}

// A child joins the set a stop signals; one spawned as the stop arrives is
// signalled at once rather than left to finish.
function own(children, child, signal) {
 children.add(child);
 if (signal?.aborted) child.kill('SIGTERM');
}

// One bounded verb, never prompting: no stdin, --non-interactive, --json.
// `step` sees each line the verb prints on stderr, where its steps are named.
export async function runVerb(entry, args, { root, env, note, step = () => {}, log, children, signal }) {
 signal?.throwIfAborted();
 const child = spawn(process.execPath, [entry, ...args, '--json', '--non-interactive'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 own(children, child, signal);
 let error, output = '';
 const lines = createInterface({ input: child.stdout });
 lines.on('line', line => { const event = events(line); if (event?.event === 'error') error = event; const text = event && waitingNote(event); if (text) note(text); log(line); });
 child.stderr.on('data', data => { output = (output + data).slice(-8192); log(String(data).trimEnd()); });
 createInterface({ input: child.stderr }).on('line', line => step(line.trim()));
 const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exit, signal) => resolve(exit ?? (signal ? 128 : 1))); });
 children.delete(child);
 if (code !== 0) throw failureFrom(code, error, output);
}

// Follow a growing log file from an offset, line by line.
async function follow(path, from, onLine, stopped) {
 let offset = from, rest = '';
 while (!stopped()) {
  const size = (await stat(path)).size;
  if (size > offset) {
   const handle = await open(path, 'r');
   try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(size - offset), position: offset });
    offset += bytesRead; rest += buffer.subarray(0, bytesRead).toString('utf8');
   } finally { await handle.close(); }
   const parts = rest.split('\n'); rest = parts.pop();
   for (const line of parts) if (onLine(line)) return;
  }
  await delay(200);
 }
}

// Start `dev` detached into its own process group with its output in a private
// log, and return its ready event once it prints one. The server outlives this
// process and stops on rer dev --stop or its idle timeout.
export async function startServer(entry, args, { root, env, logPath, children, signal, note = () => {} }) {
 signal?.throwIfAborted();
 const handle = await open(logPath, 'a', 0o600), from = (await handle.stat()).size;
 let child, exit, spawnError;
 // Listening before anything is awaited: a spawn that fails reports it on the next tick.
 try {
  child = spawn(process.execPath, [entry, 'dev', ...args, '--json'], { cwd: root, env, detached: true, stdio: ['ignore', handle.fd, handle.fd] });
  child.once('error', failure => { spawnError = failure; exit ??= 1; });
  child.once('exit', (code, name) => { exit = code ?? (name ? 128 : 1); });
 } finally { await handle.close(); }
 own(children, child, signal);
 let ready, error, output = '';
 await follow(logPath, from, line => {
  const event = events(line);
  if (event?.event === 'ready') { ready = event; return true; }
  if (event?.event === 'error') error = event;
  // rer dev --door / --direct: where the checkout moved.
  if (event?.event === 'moved') note(`moved this checkout from ${event.from} to ${event.to}; its data is kept`);
  if (!event) output = (output + line + '\n').slice(-8192);
  return false;
 }, () => exit !== undefined);
 if (!ready) {
  // Read whatever the exiting dispatcher wrote last.
  for await (const line of createInterface({ input: createReadStream(logPath, { start: from }) })) { const event = events(line); if (event?.event === 'ready') ready = event; if (event?.event === 'error') error = event; }
 }
 children.delete(child);
 if (!ready) throw failureFrom(exit, error, spawnError ? `rer could not run in ${root}: ${spawnError.code ?? spawnError.message}.` : output);
 child.unref();
 return { ready, pid: child.pid, reused: exit === 0 };
}
