import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectionContext, portListener, uncheckedInspection } from './process-diagnostics.mjs';

async function bind(host, port) {
 const socket = createServer();
 try {
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen({ host, port, exclusive: true }, resolve); });
  return { available: true };
 } catch (error) {
  // IPv6 can be disabled on the host; it must not prevent an IPv4 launch.
  return { available: host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code), code: error.code };
 } finally { if (socket.listening) await new Promise(resolve => socket.close(resolve)); }
}

// A failed diagnostic is unknown, never evidence of a foreign owner. A real
// bind can still prove availability. If a bind loses a race but inspection
// finds no listener, retry the bind within the same inspection deadline.
export async function probePort(host, port, { context = inspectionContext({ port }), hosts = [host], anyAddress = false } = {}) {
 const bindings = async () => {
  for (const address of hosts) { const result = await bind(address, port); if (!result.available) return result; }
  return { available: true };
 };
 let bound = await bindings(), listener, unchecked;
 if (!bound.available && bound.code !== 'EADDRINUSE') return bound;
 try { listener = await portListener(port, anyAddress ? undefined : host, context); }
 catch (error) { if (!uncheckedInspection(error)) throw error; unchecked = error; }
 if (listener) return { available: false, listener };
 // Inspecting sockets may have taken seconds. Bind again against the current
// state, including when the inspection consumed the rest of the budget.
 do {
  bound = await bindings();
  if (bound.available || bound.code !== 'EADDRINUSE') return bound;
  const remaining = context.deadline - performance.now();
  if (remaining <= 0) return { ...bound, unchecked };
  await delay(Math.min(100, remaining));
 } while (true);
}
