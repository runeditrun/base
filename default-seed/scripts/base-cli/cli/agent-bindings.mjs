import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

export const ownerBindingValues = ['issuer', 'installationId', 'appOrigin', 'publicKeys', 'email', 'sub', 'token', 'sessionSecret'];
export const bindingGenerator = value => value && typeof value === 'object' && Object.keys(value).join(',') === 'module' && typeof value.module === 'string';

// Factories are trusted test tooling. Their output exists only in the fresh
// installation; never persist it or include a thrown value in diagnostics.
export async function verificationBindings(root, bindings = {}, values) {
 const result = {};
 for (const [name, source] of Object.entries(bindings)) {
  if (typeof source === 'string') { result[name] = values[source]; continue; }
  try {
   await contained(root, source.module);
   const generate = (await import(pathToFileURL(resolve(root, source.module)))).default;
   if (typeof generate !== 'function') throw new Error();
   const value = await generate(Object.freeze({ ...values }));
   if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 64 * 1024) throw new Error();
   result[name] = value;
  } catch { throw new RerError('agent_owner_invalid', 'Native verification binding generation failed. The contained module must default-export a generator returning a nonempty string of at most 64 KiB; private values are not logged.', 1); }
 }
 return result;
}
