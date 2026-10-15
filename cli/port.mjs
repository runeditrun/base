import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from '../modules/job-queue/storage.mjs';
import { serversDirectory, stopInstruction } from './server-registry.mjs';
import { shared } from './shared.mjs';

export const defaultPort = 8787;

async function bindable(host, port) {
 const socket = createServer();
 try { await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, host, resolve); }); return true; }
 catch { return false; }
 finally { if (socket.listening) await new Promise(resolve => socket.close(resolve)); }
}

// The first port from `from` that nothing listens on, on any address, and that
// this host can bind. Another checkout's server may listen on every address,
// which a bind to 127.0.0.1 alone does not notice.
export async function firstFreePort(host, from = defaultPort, context) {
 const { listeningPorts, inspectionContext } = await shared('process-diagnostics.mjs');
 context ??= inspectionContext();
 const busy = await listeningPorts(context);
 for (let port = from; port <= 65535; port++) {
  if (performance.now() >= context.deadline) throw Error('Free-port search stopped at the shared inspection deadline.');
  if (!busy.has(port) && await bindable(host, port)) return port;
 }
 throw Error(`No free port from ${from} upward.`);
}

// Who holds a port: a server another checkout registered (its path and the
// command that stops it), else the process and its working directory.
export async function portHolder(port, host, root, env = process.env, context, observed) {
 const { portListener } = await shared('process-diagnostics.mjs');
 const listener = observed ?? await portListener(port, host, context);
 if (!listener) return undefined;
 const state = await readJson(join(serversDirectory(env), 'state.json'), { running: [] }).catch(() => ({ running: [] }));
 const record = (state.running ?? []).find(item => item.owner?.pid === listener.pid && item.port === port);
 return { ...listener, ...(record ? { server: record, checkout: record.checkout, own: record.checkout === await realpath(root) } : {}) };
}

// The refusal for a busy port. For a checkout that wants to move, it names the
// holder and gives the exact command that moves this checkout to a free port.
export async function busyPortMessage({ port, host, root, saved, env = process.env, context, listener }) {
 const { inspectionContext } = await shared('process-diagnostics.mjs');
 context ??= inspectionContext();
 const holder = await portHolder(port, host, root, env, context, listener);

 const kind = saved ? `Port ${port} is saved for this checkout but is` : `Port ${port} is`;
 if (!holder) return `${kind} unavailable for binding; completed inspection found no listener on ${host}. Pick a free port or retry after checking local socket availability.`;
 if (holder.own) return `${kind} held by this checkout's own ${holder.server.mode} server (PID ${holder.pid}). Stop it with: ${stopInstruction(holder.server)}`;
 const next = await firstFreePort(host, port + 1, context).catch(() => undefined);
 const who = holder.server
  ? `the ${holder.server.mode} server for ${holder.checkout} (PID ${holder.pid})`
  : `PID ${holder.pid} (${holder.command})${holder.cwd ? ` running in ${holder.cwd}` : ''}`;
 const move = next ? `\nTo move this checkout to a free port and keep its data, run this in its folder:\n  rer setup --port ${next}` : '';
 const stop = holder.server ? `\nOr stop that server first: ${stopInstruction(holder.server)}` : `\nOr stop it with: kill -TERM ${holder.pid}`;
 return `${kind} in use by ${who}.${move}${stop}`;
}
