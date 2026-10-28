import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

/** Test tooling receives only the disposable installation's existing doors. */
export async function journeyFixtures(root, declaration, context) {
 if (declaration === undefined) return undefined;
 if (!declaration || Object.keys(declaration).join(',') !== 'module' || typeof declaration.module !== 'string') throw new RerError('agent_fixtures_invalid', 'verification.fixtures must name a contained test module.', 1);
 await contained(root, declaration.module);
 const prepare = (await import(pathToFileURL(resolve(root, declaration.module)))).default;
 if (typeof prepare !== 'function') throw new RerError('agent_fixtures_invalid', 'verification.fixtures module must default-export a phase preparation function.', 1);
 return async ({ phase, tool }) => {
  try { return await prepare({ ...context, phase, tool }); }
  catch { throw new Error('Native phase preparation failed; no captured mail, credentials or fixture values are logged.'); }
 };
}
