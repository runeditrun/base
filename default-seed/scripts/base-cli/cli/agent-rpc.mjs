import { networkAdapterModules } from '../modules/agent-door/conformance/network-modules.mjs';
import { RerError } from './errors.mjs';

const denied = () => new Response('Conformance RPC services cannot reach the network.', { status: 502 });
const invalid = () => new RerError('agent_rpc_invalid', 'verification.rpc must map declared native service bindings to contained Worker modules and named RPC entrypoints. Services run without application bindings, Node APIs or network access.', 1);

export async function verificationRpc(root, config, services = []) {
 const workers = [], serviceBindings = {};
 if (config === undefined) return { workers, serviceBindings };
 if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.keys(config).length) throw invalid();
 for (const [binding, value] of Object.entries(config)) {
  if (!services.some(service => service.binding === binding) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)
   || !value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'entrypoint,module'
   || typeof value.module !== 'string' || typeof value.entrypoint !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(value.entrypoint)) throw invalid();
  let source;
  try { source = await networkAdapterModules(root, value.module, { builtins: ['cloudflare:workers'] }); }
  catch { throw invalid(); }
  const name = `rer-conformance-rpc-${workers.length}`;
  workers.push({ name, modules: source.modules, modulesRoot: source.root, compatibilityDate: '2026-09-01', compatibilityFlags: [], bindings: {}, outboundService: denied });
  serviceBindings[binding] = { name, entrypoint: value.entrypoint };
 }
 return { workers, serviceBindings };
}
