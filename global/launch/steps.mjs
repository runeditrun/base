// Run the pinned dispatcher's public verbs as children, reading its --json
// events: install and setup to completion, and dev until its `ready` event.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { LaunchFailure } from './failure.mjs';
import { captureFile } from './capture.mjs';

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
export async function runVerb(entry, args, { root, env, note, log, children, signal }) {
 signal?.throwIfAborted();
 const child = spawn(process.execPath, [entry, ...args, '--json', '--non-interactive'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 own(children, child, signal);
 let error, output = '';
 const lines = createInterface({ input: child.stdout });
 lines.on('line', line => { const event = events(line); if (event?.event === 'error') error = event; const text = event && waitingNote(event); if (text) note(text); log(line); });
 child.stderr.on('data', data => { output = (output + data).slice(-8192); log(String(data).trimEnd()); });
 const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exit, signal) => resolve(exit ?? (signal ? 128 : 1))); });
 children.delete(child);
 if (code !== 0) throw failureFrom(code, error, output);
}

// Keep the worker as the capture owner for the server's whole lifetime. Raw
// output is parsed in memory; only redacted bytes reach either captured log.
export async function startServer(entry, args, { root, env, logPath, children, signal, note = () => {} }) {
 signal?.throwIfAborted();
 const capture = await captureFile(root, logPath, env);
 let child;
 try { child = spawn(process.execPath, [entry, 'dev', ...args, '--json'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
 catch (error) { await capture.close(); throw error; }
 own(children, child, signal);
 let ready, error, output = '', spawnError, resolveReady;
 const announced = new Promise(resolve => { resolveReady = resolve; });
 const lines = createInterface({ input: child.stdout });
 lines.on('line', line => {
  const event = events(line);
  capture.line(line);
  if (event?.event === 'ready') { ready = event; resolveReady(); }
  if (event?.event === 'error') error = event;
  if (event?.event === 'moved') note(`moved this checkout from ${event.from} to ${event.to}; its data is kept`);
  if (!event) output = (output + line + '\n').slice(-8192);
 });
 child.stderr.on('data', data => { output = (output + data).slice(-8192); capture.write(data); });
 child.once('error', failure => { spawnError = failure; });
 const closed = new Promise((resolve, reject) => child.once('close', async (code, name) => {
  children.delete(child);
  try { await capture.close(); resolve(code ?? (name ? 128 : 1)); } catch (error) { reject(error); }
 }));
 // A write failure must also reach the worker after it has announced readiness.
 void closed.catch(() => {});
 const exit = await Promise.race([announced, closed]);
 if (!ready) throw failureFrom(exit, error, spawnError ? `rer could not run in ${root}: ${spawnError.code ?? spawnError.message}.` : output);
 return { ready, pid: child.pid, closed };
}
