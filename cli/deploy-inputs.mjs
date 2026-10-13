import { randomBytes } from 'node:crypto';
import { shared } from './shared.mjs';
import { invalid } from './errors.mjs';
import { readDeployEnvFile } from '../modules/deploy-kit/env-file.mjs';

// The values a Workers deploy reads for its declared secrets: this process's
// environment, then the --env-file (which wins), then what rer supplies itself:
// the local setup owner's email, and a fresh value for each secret the setup
// manifest generates (a session secret, the one-time setup token). A value only
// reaches a Worker that lacks that secret; an existing one is kept unchanged.
export async function deployEnvironment({ root, options, declaration, setupManifest, settings, localOnlyKeys = [] }) {
 const env = { ...process.env }, supplied = [];
 if (options.envFile) {
  let values;
  try { values = await readDeployEnvFile(root, options.envFile, localOnlyKeys); }
  catch (error) { throw invalid(`The --env-file ${options.envFile} could not be used: ${error.code === 'ENOENT' ? 'no such file' : error.message}.`); }
  Object.assign(env, values);
 }
 const secrets = Array.isArray(declaration.secrets) ? declaration.secrets : [];
 const absent = item => item && !env[item.environment]?.trim();
 const emailField = setupManifest?.steps?.find(step => step.type === 'owner-claim')?.emailField;
 const email = secrets.find(item => item?.binding === emailField);
 if (absent(email) && settings) {
  const { readSettings } = await shared('adapter-settings.mjs');
  const owner = (await readSettings(root, settings)).values[emailField];
  if (typeof owner === 'string' && owner.includes('@')) { env[email.environment] = owner; supplied.push(email.binding); }
 }
 for (const field of setupManifest?.fields ?? []) {
  const item = field.kind === 'secret' && field.generate ? secrets.find(entry => entry?.binding === field.name) : undefined;
  if (absent(item)) { env[item.environment] = randomBytes(32).toString(field.generate); supplied.push(item.binding); }
 }
 return { env, supplied };
}
