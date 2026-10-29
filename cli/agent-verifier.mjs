import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';
import { FixtureDatabaseError } from '../modules/agent-door/conformance/fixtures.mjs';

export async function verificationInvoke(root, config) {
 if (config === undefined) return;
 if (!config || typeof config !== 'object' || Object.keys(config).sort().join(',') !== 'entrypoint,module'
  || typeof config.module !== 'string' || typeof config.entrypoint !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(config.entrypoint)) throw new RerError('agent_invoke_invalid', 'verification.invoke must name a contained module and the native Worker entrypoint.', 1);
 await contained(root, config.module);
 const driver = (await import(pathToFileURL(resolve(root, config.module)))).default;
 if (typeof driver !== 'function') throw new RerError('agent_invoke_invalid', 'verification.invoke module must default-export a native worker driver.', 1);
 return { entrypoint: config.entrypoint, run: hosted => async (name, args, who) => {
  try { return await driver({ name, args, who, worker: entrypoint => hosted.worker(entrypoint) }); }
  catch { throw new Error('Native verification worker invocation failed; private driver values are not logged.'); }
 } };
}

export async function verificationJourney(root, path, context) {
 if (path === undefined) return {};
 await contained(root, path);
 const module = await import(pathToFileURL(resolve(root, path)));
 if (typeof module.default !== 'function' || ['beforeStep', 'afterStep'].some(key => module[key] !== undefined && typeof module[key] !== 'function')) throw new RerError('agent_journey_invalid', 'verification.journey must default-export a native journey; optional beforeStep and afterStep exports must be functions.', 1);
 const call = async (fn, value) => {
  try { await fn({ ...context, ...value }); }
  catch (error) {
   if (error?.code === 'hosted_database_invalid') throw new FixtureDatabaseError();
   throw new Error('Native verification journey failed; no captured mail or fixture values are logged.');
  }
 };
 return { nativeJourney: value => call(module.default, value),
  nativeStep: async ({ stage, ...value }) => { if (module[stage]) await call(module[stage], value); },
 };
}
