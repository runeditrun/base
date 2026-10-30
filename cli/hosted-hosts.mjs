import { RerError } from './errors.mjs';

// Admission is explicit: never infer additional hosts from arbitrary app vars.
// Each named binding must contain a bare canonical hostname in the selected
// deployment declaration, so verification and the hosted Worker agree.
export function hostedOrigins(declaration, bindings, primary) {
 if (bindings === undefined) return Object.freeze([primary]);
 const invalid = () => new RerError('agent_hosts_invalid', 'verification.publicHosts must list unique deployment variable names whose vars values are canonical hostnames.', 1);
 if (!Array.isArray(bindings) || new Set(bindings).size !== bindings.length) throw invalid();
 const origins = new Set([primary]);
 for (const name of bindings) {
  const host = declaration.vars?.[name];
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name) || !Object.hasOwn(declaration.vars ?? {}, name)
   || typeof host !== 'string' || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) throw invalid();
  const origin = `https://${host}`;
  try { if (new URL(origin).hostname !== host) throw invalid(); }
  catch { throw invalid(); }
  origins.add(origin);
 }
 return Object.freeze([...origins]);
}
