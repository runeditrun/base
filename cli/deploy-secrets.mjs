import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { invalid, missing, refuse } from './errors.mjs';
import { cloudflareCredentials, missingCredentialsMessage } from './deploy-needs.mjs';
import { shared } from './shared.mjs';
import { readDeployEnvFile } from '../modules/deploy-kit/env-file.mjs';
import { cloudflare } from '../modules/deploy-kit/provider.mjs';
import { ownerWorkerName } from '../modules/deploy-kit/owner.mjs';

// Secrets rer generates for a deployment (the setup manifest's `generate` secret
// fields, such as a session or subscriber-link secret) outlive the run that made
// them: rer keeps them with the environment's deployment record, in the private
// (0600) file .rer/deploy/<environment>.secrets.env, and a redeploy reuses them.
// Cloudflare never reads a secret's value back, only its name, so a checkout
// without that file cannot know what a live Worker holds: rer then refuses to
// generate a replacement unless `--rotate-secret NAME` asks for one. The one-time
// owner setup token is not kept: rer issues it fresh and retires it after the claim.
export const savedSecretsFile = environment => join('.rer', 'deploy', `${environment}.secrets.env`);

const ignore = '# rer: generated deployment secrets never enter Git.\n*.secrets.env\n.gitignore\n';

/** The declared secrets rer generates and keeps: `generate` secret fields, except the owner setup token. */
export function keptSecrets(declaration, setupManifest) {
 const token = setupManifest?.steps?.find(step => step.type === 'owner-claim')?.tokenField ?? 'SETUP_TOKEN';
 const declared = Array.isArray(declaration?.secrets) ? declaration.secrets : [];
 return (setupManifest?.fields ?? []).flatMap(field => {
  const item = field.kind === 'secret' && field.generate && field.name !== token ? declared.find(entry => entry?.binding === field.name) : undefined;
  return item ? [item] : [];
 });
}

/** `--rotate-secret A,B`: each must be a secret rer generates and keeps, and not supplied by the person. */
export function rotations(options, kept, env) {
 const names = options.rotateSecret === undefined ? [] : options.rotateSecret.split(',');
 const generated = kept.map(item => item.binding);
 for (const name of names) {
  if (!generated.includes(name)) throw invalid(`--rotate-secret names a secret rer generates for this deployment${generated.length ? ` (${generated.join(', ')})` : ', and this seed declares none'}; ${name} is not one. Set another secret with --set-secret.`);
  const item = kept.find(entry => entry.binding === name);
  if (env[item.environment]?.trim()) throw invalid(`--rotate-secret ${name} generates a fresh value, but ${item.environment} is also set in the environment or --env-file. Leave it unset to rotate, or deploy with the value you supplied.`);
 }
 return names;
}

/** The values kept for this environment, by binding; {} when none are. */
export async function savedSecrets(root, environment) {
 try { return await readDeployEnvFile(root, savedSecretsFile(environment)); }
 catch (error) {
  if (error.code === 'ENOENT') return {};
  throw invalid(`${savedSecretsFile(environment)} could not be read: ${error.message}. Restore it as an owned 0600 file of NAME=VALUE lines.`);
 }
}

/** Keep these values (merged over what is kept) before they can reach a Worker. */
export async function saveSecrets(root, environment, values) {
 if (!Object.keys(values).length) return;
 const { privateDirectory, writePrivateFile } = await shared('private-files.mjs');
 await privateDirectory(root, ['.rer', 'deploy']);
 const gitignore = join(root, '.rer', 'deploy', '.gitignore');
 const current = await readFile(gitignore, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
 if (!current.split('\n').includes('*.secrets.env')) await writePrivateFile(gitignore, current + (current && !current.endsWith('\n') ? '\n' : '') + ignore);
 const merged = { ...await savedSecrets(root, environment), ...values };
 await writePrivateFile(join(root, savedSecretsFile(environment)), Object.entries(merged).map(([name, value]) => `${name}=${value}\n`).join(''));
}

export const forgetSecrets = (root, environment) => rm(join(root, savedSecretsFile(environment)), { force: true });

/** The secret names the environment's live Worker holds; [] when it has no Worker yet. */
export async function liveSecretNames(env, declaration, environment) {
 const api = cloudflare({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
 try { return (await api.request(`/workers/scripts/${ownerWorkerName(declaration.project, environment)}/secrets`)).map(row => row.name); }
 catch (error) { if (error.status === 404) return []; throw error; }
}

/** Refuse to replace generated secrets a live Worker holds when rer kept no value for them. */
export function refuseRotation({ worker, held, environment, again }) {
 const names = held.map(item => item.binding), many = held.length > 1, them = many ? 'them' : 'it';
 return refuse(`The live ${worker} Worker holds ${names.join(', ')}, which rer generates for this deployment, but this checkout keeps no value for ${them} in ${savedSecretsFile(environment)}. A new value would replace the live one and break everything made with it, such as signed-in sessions and links already emailed. Nothing was uploaded.\nTo keep ${them}: copy ${savedSecretsFile(environment)} from the checkout that deployed this environment, or set ${held.map(item => item.environment).join(', ')} in --env-file, then run ${again} again.\nTo replace ${them} on purpose: ${again} --rotate-secret ${names.join(',')}`);
}

/** Before a seed's own deploy hook uploads them: refuse to replace generated secrets a
 * live Worker holds without a kept value, then keep what this run generated. */
export async function keepHookSecrets({ root, environment, declaration, setupManifest, env, generated, reused, rotated, again, report }) {
 const kept = keptSecrets(declaration, setupManifest), fresh = generated.filter(binding => !rotated.includes(binding));
 if (fresh.length) {
  if (cloudflareCredentials.some(name => !env[name]?.trim())) throw missing(missingCredentialsMessage(declaration, env));
  const live = await liveSecretNames(env, declaration, environment);
  const held = kept.filter(item => fresh.includes(item.binding) && live.includes(item.binding));
  if (held.length) throw refuseRotation({ worker: ownerWorkerName(declaration.project, environment), held, environment, again });
 }
 const { keepInstallationKey } = await import('./deploy-installation-key.mjs');
 await keepInstallationKey({ root, environment, declaration, env, generated });
 await keepSecrets({ root, environment, kept, env, generated, reused, report });
}

/** Keep the generated values that reach the Worker, and say which were generated or reused. */
export async function keepSecrets({ root, environment, kept, env, generated, reused, report }) {
 await saveSecrets(root, environment, Object.fromEntries(kept.filter(item => generated.includes(item.binding)).map(item => [item.binding, env[item.environment]])));
 const file = savedSecretsFile(environment), them = names => names.length > 1 ? 'them' : 'it';
 if (generated.length) report(`rer generated ${generated.join(', ')} for this deployment and keeps ${them(generated)} in ${file} (private; Git ignores it), so a redeploy reuses ${them(generated)}. To deploy this environment from another checkout, copy that file there.`);
 if (reused.length) report(`rer reused ${reused.join(', ')} kept in ${file}.`);
}
