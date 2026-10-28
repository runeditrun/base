import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { policy as validatePolicy } from '../modules/portability/catalogue.mjs';
import { PortabilityError } from '../modules/portability/index.mjs';

// Only seed configuration supplies this entry point. Never resolve executable
// policy from archive metadata, or stringify functions across the process seam.
export async function policyModuleURL(root, entry) {
 try {
  let path;
  if (entry instanceof URL || (typeof entry === 'string' && entry.startsWith('file:'))) {
   const url = new URL(entry);
   if (url.protocol !== 'file:' || url.search || url.hash) throw new Error();
   path = fileURLToPath(url);
  } else {
   if (typeof entry !== 'string' || !entry || isAbsolute(entry) || /^[a-z][a-z\d+.-]*:/i.test(entry)) throw new Error();
   path = resolve(root, entry);
  }
  const base = await realpath(root), actual = await realpath(path), within = relative(base, actual);
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within) || !(await stat(actual)).isFile()) throw new Error();
  return pathToFileURL(actual).href;
 } catch { throw new PortabilityError('invalid_policy_module', 409); }
}

export function serializablePolicy(input) {
 const seen = new Set();
 function copy(value) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new PortabilityError('policy_module_required', 409);
  seen.add(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
   if (Array.isArray(value) && key === 'length') continue;
   const descriptor = Object.getOwnPropertyDescriptor(value, key);
   if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new PortabilityError('policy_module_required', 409);
   result[key] = copy(descriptor.value);
  }
  seen.delete(value);
  return result;
 }
 const result = copy(input);
 validatePolicy(result);
 return result;
}

export async function loadPolicy(root, policy, policyModule, bindings) {
 if (policyModule === undefined) return serializablePolicy(policy);
 if (policy !== undefined) throw new PortabilityError('ambiguous_policy', 409);
 try {
  const module = await import(await policyModuleURL(root, policyModule));
  validatePolicy(module.default);
  if (module.createPolicy !== undefined && typeof module.createPolicy !== 'function') throw new Error();
  const input = bindings && module.createPolicy ? await module.createPolicy(bindings) : module.default;
  validatePolicy(input);
  return input;
 } catch { throw new PortabilityError('invalid_policy_module', 409); }
}
