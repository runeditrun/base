import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hookState } from './deploy-hook-record.mjs';
import { deployAgain } from './deploy-inputs.mjs';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';

const recordPath = environment => join('.rer', 'deploy', `${environment}.json`);

// Existing-deployment commands share the same hook pointer and default record.
// A first deploy still creates its record through the kit as before.
export async function deploymentRecord(root, options) {
 const environment = options.environment ?? 'production';
 const state = await hookState(root, environment);
 const path = await contained(root, state ?? recordPath(environment), { optional: true });
 try { await access(path); }
 catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const availableDeployments = (await environments(root)).map(environment => ({ environment, command: commandFor(options, environment) }));
  const held = availableDeployments.length
   ? `It holds:\n${availableDeployments.map(item => `  ${item.environment}: ${item.command}`).join('\n')}`
   : 'This checkout holds no deployment environments. Run it from the checkout that deployed it.';
  const signin = options.verb === 'signin';
  throw new RerError(signin ? 'safety_refusal' : 'command_failed', `No deployment of the ${environment} environment in this checkout. ${held}`, signin ? 4 : 1, { environment, availableDeployments });
 }
 return state;
}

async function environments(root) {
 let entries;
 try { entries = await readdir(await contained(root, '.rer/deploy', { optional: true })); }
 catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 const names = new Set(entries.flatMap(name => /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\.hook)?\.json$/.exec(name)?.slice(1) ?? []).filter(name => name.length <= 32));
 const held = await Promise.all([...names].map(async environment => {
  try {
   const state = await hookState(root, environment);
   const path = await contained(root, state ?? recordPath(environment));
   const record = JSON.parse(await readFile(path, 'utf8'));
   return record?.kind === 'rer-deploy-owner-state' && record.environment === environment ? environment : undefined;
  } catch { return undefined; } // An unrelated or broken file is not a held deployment.
 }));
 return held.filter(Boolean).sort();
}

function commandFor(options, environment) {
 const again = deployAgain({ ...options, environment });
 if (options.verb === 'signin') return again.replace(/^rer deploy/, 'rer signin');
 if (options.remove) return `${again} --remove --yes`;
 if (options.setSecret) return `${again} --set-secret ${options.setSecret}`;
 if (options.unsetSecret) return `${again} --unset-secret ${options.unsetSecret}`;
 return again;
}
