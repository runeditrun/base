import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
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

// Hooks and their child builds read process.env. Install the private file for
// this command only, and restore even keys changed by a failing hook.
export async function withDeployEnvironment(root, options, run) {
 const saved = { ...process.env };
 const { env } = await deployEnvironment({ root, options, declaration: {} });
 const { createRedaction, credentialValues } = await shared('redaction.mjs');
 const redaction = createRedaction();
 // Provider names are public enum values. Masking "resend" would also hide
 // RESEND_API_KEY in the preflight's instruction for the missing credential.
 const publicProvider = (key, value) => key === 'MAIL_PROVIDER' && /^(resend|sendgrid|cloudflare|rer|later)$/.test(value);
 redaction.addSecrets([...credentialValues(env), ...Object.entries(env).filter(([key, value]) => saved[key] !== value && !publicProvider(key, value)).map(([, value]) => value)]);
 Object.assign(process.env, env);
 try { return await run(redaction); }
 catch (error) { if (typeof error?.message === 'string') error.message = redaction.redact(error.message); throw error; }
 finally {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  Object.assign(process.env, saved);
 }
}

export function deployAgain(options) {
 const quote = value => /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\"'\"'")}'`;
 return `rer deploy --environment ${quote(options.environment ?? 'production')}${options.envFile ? ` --env-file ${quote(options.envFile)}` : ''}${options.cwd ? ` --cwd ${quote(relative(process.cwd(), options.cwd) || '.')}` : ''}`;
}
