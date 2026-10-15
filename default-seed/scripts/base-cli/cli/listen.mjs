import { setTimeout as delay } from 'node:timers/promises';
import { refuse } from './errors.mjs';
import { shared } from './shared.mjs';

// Bind the actual serving socket, including the race after a successful
// preflight. Only a positive listener observation names another process.
export async function listen(server, host, port) {
 let context;
 for (;;) {
  try {
   await new Promise((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); }, failed = error => { cleanup(); reject(error); };
    const cleanup = () => { server.removeListener('listening', ready); server.removeListener('error', failed); };
    server.once('listening', ready); server.once('error', failed);
    try { server.listen(port, host); } catch (error) { failed(error); }
   });
   return;
  } catch (error) {
   if (error.code !== 'EADDRINUSE') throw refuse(`Could not listen on ${host} port ${port}: ${error.code === 'EACCES' ? 'permission denied' : error.code ?? 'socket error'}. Check the address and permissions, then run rer dev again or use rer setup --port PORT with a free port.`);
   const unavailable = () => refuse(`Port ${port} is still unavailable on ${host} after retrying; no listener was identified. Run rer dev again or use rer setup --port PORT with a free port.`);
   if (context && performance.now() >= context.deadline) throw unavailable();
   const { inspectionContext } = await shared('process-diagnostics.mjs');
   const { probePort } = await shared('port-probe.mjs');
   context ??= inspectionContext({ port });
   const result = await probePort(host, port, { context });
   if (result.listener) throw refuse(`Port ${port} is in use by PID ${result.listener.pid} (${result.listener.command}). Stop it with kill -TERM ${result.listener.pid}, then run rer dev again, or use rer setup --port PORT with a free port.`);
   if (result.unchecked && !result.available) throw result.unchecked;
   if (!result.available) throw unavailable();
   await delay(Math.min(100, Math.max(0, context.deadline - performance.now())));
  }
 }
}
