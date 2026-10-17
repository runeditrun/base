import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectionContext, portListener, searchContext, uncheckedInspection } from './process-diagnostics.mjs';

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
// A free-port search (`searching`) only needs to move on from a port in use:
// it skips one on the failed bind alone, without the slow ownership check.
export async function probePort(host, port, { context = inspectionContext({ port }), hosts = [host], anyAddress = false, searching = false } = {}) {
 const bindings = async () => {
  for (const address of hosts) { const result = await bind(address, port); if (!result.available) return result; }
  return { available: true };
 };
 let bound = await bindings(), listener, unchecked;
 if (!bound.available && (bound.code !== 'EADDRINUSE' || searching)) return bound;
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

// How many ports a free-port search tries, counting from its first one. The
// search is bounded by this count and by nothing else: a busy computer makes
// each bind slower, and the search waits for every bind's answer.
export const searchCandidates = 1000;

// The first port from `from` that probePort finds available and `claim` secures
// (claim may be omitted), among the next `searchCandidates` ports. A port in
// `skip` counts as tried and in use. Each candidate's ownership check has its
// own load-scaled budget, so no candidate can spend another's. Without a free
// port, the result says what was tried: { range: [first, last], tried }.
export async function searchPort({ host, from, hosts, skip = () => false, claim = async () => ({}), verb }) {
 const last = Math.min(65535, from + searchCandidates - 1);
 for (let port = from; port <= last; port++) {
  if (skip(port)) continue;
  const context = searchContext({ port, verb });
  if (!(await probePort(host, port, { context, hosts, anyAddress: true, searching: true })).available) continue;
  const claimed = await claim(port);
  if (claimed) return { port, ...claimed };
 }
 return { range: [from, last], tried: last - from + 1 };
}
