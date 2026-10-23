import { readSettings } from './adapter-settings.mjs';
import { loopbackRequest } from './app-fetch.mjs';
import { inspectionContext, listenerOwnership } from './process-diagnostics.mjs';

// Diagnosis only: an alternate Host can explain a failed start, never make it
// ready. Inspect custody before sending either request to the internal listener.
export async function startOriginDiagnostic(context, hooks, child, health, ready) {
 if (context.verb !== 'dev' || !context.runtimePort || ready || hooks.health || health !== '/health' || !hooks.secrets?.originKey) return;
 const key = hooks.secrets.originKey;
 const saved = (await readSettings(context.root, hooks.secrets)).values[key];
 let previous, selected;
 try { previous = new URL(saved); selected = new URL(context.origin); } catch { return; }
 if (previous.origin !== saved || previous.origin === selected.origin || previous.protocol !== 'http:' || selected.protocol !== 'http:') return;
 const { signal, runtimePort: port } = context;
 const ownership = await listenerOwnership(child.pid, port, '127.0.0.1', inspectionContext({ port, verb: 'dev', signal }));
 if (ownership.status !== 'owned') return;
 const request = host => loopbackRequest({ port, path: health, headers: { host }, signal, timeoutMs: 2000 });
 let rejected, accepted;
 try { [rejected, accepted] = await Promise.all([request(selected.host), request(previous.host)]); }
 catch (error) { if (signal?.aborted) throw error; return; }
 if (rejected.status !== 404 || accepted.status !== 200) return;
 try { if (JSON.parse(accepted.body.toString()).status !== 'ok') return; } catch { return; }
 return `Origin mismatch: GET ${new URL(health, selected).href} returns HTTP 404, but the application's owned internal port ${port} returns healthy JSON with Host ${previous.host}. The runtime still uses saved ${key}=${previous.origin} instead of RER_DEV_ORIGIN=${selected.origin}. Update the seed's local Worker entry to apply RER_DEV_ORIGIN to ${key} before its host checks; .dev.vars can override Vite config.vars. Readiness failed; the application was not accepted.`;
}
