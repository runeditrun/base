import { setTimeout as delay } from 'node:timers/promises';
import { refuse } from './errors.mjs';
import { shared } from './shared.mjs';
import { busyPortMessage } from './port.mjs';

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
   const unavailable = async listener => refuse(await busyPortMessage({ port, host, root: process.cwd(), context, listener: listener ?? null }));
   if (context && performance.now() >= context.deadline) throw await unavailable();
   const { inspectionContext } = await shared('process-diagnostics.mjs');
   const { probePort } = await shared('port-probe.mjs');
   context ??= inspectionContext({ port });
   const result = await probePort(host, port, { context });
   if (!result.available) throw await unavailable(result.listener);
   await delay(Math.min(100, Math.max(0, context.deadline - performance.now())));
  }
 }
}
