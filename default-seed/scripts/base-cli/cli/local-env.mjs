import { refuse } from './errors.mjs';
import { shared } from './shared.mjs';
import { refuseLocalEnvFiles } from '../modules/deploy-kit/local-only.mjs';

// Wrangler (and the Cloudflare Vite plugin through it) reads .dev.vars, then .env
// and process.env, and writes what it read into dist/<worker>/.dev.vars. During a
// deploy process.env holds the deployment's secrets.
const switches = { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' };

// Every build rer runs for a deployment, and a seed's own deploy hook, runs with
// the checkout's local settings files moved aside (restored afterwards, or by the
// next operation after a hard kill) and those Wrangler sources switched off, so
// no bundler can copy local credentials into what is uploaded.
export async function withoutLocalSettings(root, { settings = [], operationToken } = {}, action) {
 const { withoutLocalVariables } = await shared('local/build.mjs');
 const saved = Object.fromEntries(Object.keys(switches).map(key => [key, process.env[key]]));
 return withoutLocalVariables(root, async () => {
  Object.assign(process.env, switches);
  try { return await action(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
 }, { nested: operationToken, settings: ['.dev.vars', '.dev.vars.previous', ...(Array.isArray(settings) ? settings : []).filter(path => typeof path === 'string')] });
}

// rer build and rer deploy refuse build output that holds a local settings file,
// naming it. `uploaded` says a deploy hook has already sent its build.
export async function refuseLocalEnvOutput(root, outputs, { uploaded = false } = {}) {
 try { await refuseLocalEnvFiles(root, outputs ?? ['dist']); }
 catch (error) {
  if (!error.resource) throw error;
  if (uploaded) throw refuse(`The deploy hook's build output holds the local settings file ${error.resource}, and the hook has already uploaded its build, so it may be on the live Worker. Remove what copies it into the build output, rotate every credential in that file, then run rer deploy again.`);
  throw refuse(`The build output holds the local settings file ${error.resource}; a deployment never carries one. Remove what puts it there (a file in public/, or a build step that copies it), then run the command again. Nothing was uploaded.`);
 }
}
