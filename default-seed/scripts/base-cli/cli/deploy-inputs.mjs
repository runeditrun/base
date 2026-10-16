import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
import { shared } from './shared.mjs';
import { invalid } from './errors.mjs';
import { readDeployEnvFile } from '../modules/deploy-kit/env-file.mjs';
import { publicOrigin } from '../modules/deploy-kit/public-origin.mjs';
import { keptSecrets, rotations, savedSecrets } from './deploy-secrets.mjs';

// The values a Workers deploy reads for its declared secrets: this process's
// environment, then the --env-file (which wins), then what rer supplies itself:
// the local setup owner's email, and for each secret the setup manifest generates
// the value kept for this environment (deploy-secrets.mjs), else a fresh one
// (`generated`; always fresh for the one-time setup token and --rotate-secret).
// The owner kit sends a value only to a Worker that lacks that secret.
export async function deployEnvironment({ root, options, declaration, setupManifest, settings, localOnlyKeys = [] }) {
 const env = { ...process.env }, supplied = [];
 if (options.envFile) {
  let values;
  try { values = await readDeployEnvFile(root, options.envFile, localOnlyKeys); }
  catch (error) { throw invalid(`The --env-file ${options.envFile} could not be used: ${error.code === 'ENOENT' ? 'no such file' : error.message}.`); }
  Object.assign(env, values);
 }
 const originSetting = declaration.publicOriginSetting;
 if (originSetting !== undefined && env[originSetting] === undefined && settings) {
  const { readSettings } = await shared('adapter-settings.mjs');
  const value = (await readSettings(root, settings)).values[originSetting];
  if (value !== undefined) env[originSetting] = value;
 }
 try { publicOrigin(declaration, env); }
 catch { throw invalid('Declare publicOriginSetting beside originVar and set it to an HTTPS origin (https://host[:port]), without credentials, path, query or fragment.'); }
 const secrets = Array.isArray(declaration.secrets) ? declaration.secrets : [];
 const absent = item => item && !env[item.environment]?.trim();
 const emailField = setupManifest?.steps?.find(step => step.type === 'owner-claim')?.emailField;
 const email = secrets.find(item => item?.binding === emailField);
 if (absent(email) && settings) {
  const { readSettings } = await shared('adapter-settings.mjs');
  const owner = (await readSettings(root, settings)).values[emailField];
  if (typeof owner === 'string' && owner.includes('@')) { env[email.environment] = owner; supplied.push(email.binding); }
 }
 // withDeployEnvironment reads only the --env-file, with no declaration to rotate in.
 const kept = keptSecrets(declaration, setupManifest), rotate = setupManifest || declaration.project ? rotations(options, kept, env) : [];
 const saved = kept.some(absent) ? await savedSecrets(root, options.environment ?? 'production') : {};
 const generated = [], reused = [];
 for (const field of setupManifest?.fields ?? []) {
  const item = field.kind === 'secret' && field.generate ? secrets.find(entry => entry?.binding === field.name) : undefined;
  if (!absent(item)) continue;
  const keep = kept.includes(item), value = keep && !rotate.includes(item.binding) ? saved[item.binding] : undefined;
  env[item.environment] = value ?? randomBytes(32).toString(field.generate);
  supplied.push(item.binding);
  if (value) reused.push(item.binding); else if (keep) generated.push(item.binding);
 }
 return { env, supplied, generated, reused, rotated: rotate };
}

// Hooks and their child builds read process.env. Install the private file for
// this command only, and restore even keys changed by a failing hook. Output
// redaction follows what the deploy declaration says each value is: declared
// secrets and credentials stay redacted, declared non-secret settings print in
// full, and an undeclared --env-file value stays redacted with a note on how to
// declare it.
export async function withDeployEnvironment(project, options, out, run) {
 const saved = { ...process.env };
 const { env } = await deployEnvironment({ root: project.root, options, declaration: {} });
 const { createRedaction } = await shared('redaction.mjs');
 const { declaredSettings, settingKinds, undeclaredNotice } = await import('./deploy-settings.mjs');
 const declared = await declaredSettings(project), kinds = await settingKinds(declared);
 const redaction = createRedaction();
 // Provider names are public enum values. Masking "resend" would also hide
 // RESEND_API_KEY in the preflight's instruction for the missing credential.
 const publicProvider = (key, value) => key === 'MAIL_PROVIDER' && /^(resend|sendgrid|cloudflare|rer|later)$/.test(value);
 const supplied = Object.entries(env).filter(([key, value]) => saved[key] !== value);
 redaction.addSecrets([...kinds.privateValues(env), ...supplied.filter(([key, value]) => !kinds.shown(key, value) && !publicProvider(key, value)).map(([, value]) => value)]);
 const undeclared = declared.declaration ? kinds.undeclared(supplied.map(([key]) => key)) : [];
 if (undeclared.length) {
  const message = undeclaredNotice(undeclared, declared.path);
  if (options.json) out.event('warning', { code: 'undeclared_env_setting', names: undeclared, message }); else out.progress(`${message}\n`);
 }
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
