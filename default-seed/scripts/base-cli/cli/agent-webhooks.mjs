import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

export async function verificationWebhooks(root, config, secrets) {
 if (config === undefined) return undefined;
 try {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['module', 'prepare'].includes(key))
   || typeof config.module !== 'string' || !Array.isArray(config.prepare) || !config.prepare.length || !config.prepare.every(value => typeof value === 'string')) throw new Error();
  await contained(root, config.module);
  const build = (await import(pathToFileURL(resolve(root, config.module)))).default;
  if (typeof build !== 'function') throw new Error();
  return { prepare: config.prepare, requests: async context => {
   try { return await build({ ...context, secrets }); }
   catch { throw new Error('The seed webhook request builder could not construct its per-run signature probes.'); }
  } };
 } catch { throw new RerError('agent_webhooks_invalid', 'verification.webhooks must name a contained request-builder module and preparation journey steps.', 1); }
}
