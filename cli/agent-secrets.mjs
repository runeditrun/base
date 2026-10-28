import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

// Trusted test tooling gets only this disposable installation's declared D1
// handles. Neither the accessor nor its values become an application route.
export async function verificationSecrets(root, source, database) {
 if (source === undefined) return {};
 try {
  if (typeof source !== 'string' || !source.endsWith('.mjs')) throw new Error();
  await contained(root, source);
  const read = (await import(pathToFileURL(resolve(root, source)))).default;
  if (typeof read !== 'function') throw new Error();
  const values = await read({ database });
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length
   || Object.entries(values).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || !value || value.length > 16384)) throw new Error();
  return values;
 } catch {
  // Accessor errors may contain a secret or a database row. Never report them.
  throw new RerError('agent_secret_source_invalid', 'verification.network.secretSource must be a contained .mjs accessor returning nonempty named string secrets from the disposable installation.', 1);
 }
}
