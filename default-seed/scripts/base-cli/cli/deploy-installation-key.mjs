import { savedSecrets, saveSecrets, savedSecretsFile, liveSecretNames } from './deploy-secrets.mjs';
import { refuse, RerError } from './errors.mjs';
import { installationKeyId } from '../modules/dependencies/sealing.mjs';
import { retiredInstallationKeys as parseRetiredKeys } from '../modules/dependencies/custody.mjs';
import { shared } from './shared.mjs';
import { join } from 'node:path';

/** Save the first deployment key before a Worker can receive it, including when
 * its upload answer is lost. Never confuse a newly generated value with a live key. */
export async function keepInstallationKey({ root, environment, declaration, env, generated }) {
 const secret = declaration.secrets?.find(item => item.binding === 'INSTALLATION_KEY');
 if (!secret || (await savedSecrets(root, environment)).INSTALLATION_KEY) return;
 if (generated.includes(secret.binding) && (await liveSecretNames(env, declaration, environment)).includes(secret.binding)) throw refuse('The Worker already holds INSTALLATION_KEY, but this checkout has no current key. Restore the private deployment secrets file before continuing.');
 if (env[secret.environment]) await saveSecrets(root, environment, { INSTALLATION_KEY: env[secret.environment] });
}

/** Persist both keys before publishing either; a retry always uses this exact pair. */
export async function rotateInstallationKey({ root, environment, declaration, env, owner, state, report, addSecrets }) {
 const current = declaration.secrets?.find(item => item.binding === 'INSTALLATION_KEY');
 const previous = declaration.secrets?.find(item => item.binding === 'INSTALLATION_KEY_PREVIOUS');
 if (!current || !previous?.optional) throw refuse('Installation key rotation requires declared INSTALLATION_KEY and optional INSTALLATION_KEY_PREVIOUS bindings.');
 const saved = await savedSecrets(root, environment);
 if (!saved.INSTALLATION_KEY) throw refuse('Restore the current installation key in the private deployment secrets file before rotating it.');
 if (saved.INSTALLATION_KEY_REOPEN) throw refuse('Installation key reopen is unfinished. Resume --reopen-installation-key with the saved key ID before rotating.');
 const pair = { INSTALLATION_KEY: saved.INSTALLATION_KEY_PREVIOUS ? saved.INSTALLATION_KEY : env[current.environment], INSTALLATION_KEY_PREVIOUS: saved.INSTALLATION_KEY_PREVIOUS ?? saved.INSTALLATION_KEY };
 if (!pair.INSTALLATION_KEY || pair.INSTALLATION_KEY === pair.INSTALLATION_KEY_PREVIOUS) throw refuse('Installation key rotation requires distinct current and previous keys.');
 const retired = await retiredInstallationKeys(saved);
 retired.set(await installationKeyId(pair.INSTALLATION_KEY_PREVIOUS), pair.INSTALLATION_KEY_PREVIOUS);
 addSecrets([...Object.values(pair), ...retired.values()]);
 await saveSecrets(root, environment, { ...pair, INSTALLATION_KEY_RETIRED: serializeRetired(retired) });
 await resealAndRetire({root, environment, current, previous, pair, retired, env, state, owner, report});
 report('Rotated INSTALLATION_KEY, resealed every dependency key, and removed INSTALLATION_KEY_PREVIOUS after verifying the owned Worker. Retired keys remain in private custody for older D1 restores.');
}

/** Explicitly reopen one retained historical key without changing current custody. */
export async function reopenInstallationKey({ root, environment, declaration, env, owner, state, kid, report, addSecrets }) {
 const current = declaration.secrets?.find(item => item.binding === 'INSTALLATION_KEY');
 const previous = declaration.secrets?.find(item => item.binding === 'INSTALLATION_KEY_PREVIOUS');
 if (!current || !previous?.optional) throw refuse('Installation key reopen requires declared INSTALLATION_KEY and optional INSTALLATION_KEY_PREVIOUS bindings.');
 const saved = await savedSecrets(root, environment), retired = await retiredInstallationKeys(saved);
 if (!saved.INSTALLATION_KEY || !retired.has(kid)) throw unavailable('The requested retired installation key is not in this environment\'s private custody. Restore the private deployment secrets file from the deploying checkout, or relink dependencies. Nothing was uploaded.');
 if (saved.INSTALLATION_KEY_PREVIOUS && (saved.INSTALLATION_KEY_REOPEN !== kid || saved.INSTALLATION_KEY_PREVIOUS !== retired.get(kid))) throw refuse('Another installation key operation is unfinished. Resume its recorded rotation or reopen first.');
 const pair = { INSTALLATION_KEY: saved.INSTALLATION_KEY, INSTALLATION_KEY_PREVIOUS: retired.get(kid) };
 addSecrets([...Object.values(pair), ...retired.values()]);
 await saveSecrets(root, environment, {...pair, INSTALLATION_KEY_REOPEN:kid});
 await resealAndRetire({root, environment, current, previous, pair, retired, env, state, owner, report});
 report(`Reopened retired installation key ${kid}, resealed and verified every dependency key with the current key, and removed INSTALLATION_KEY_PREVIOUS. Retired custody is retained.`);
}

const unavailable = message => new RerError('installation_key_unavailable', message, 4);
const serializeRetired = retired => [...retired].map(([kid, value]) => `${kid}:${value}`).join(',');

async function retiredInstallationKeys(saved) {
 try { return await parseRetiredKeys(saved.INSTALLATION_KEY_RETIRED); }
 catch { throw unavailable('Retired installation key custody is invalid. Restore the private deployment secrets file before rotating or reopening. Nothing was uploaded.'); }
}

async function resealAndRetire({root, environment, current, previous, pair, retired, env, state, owner, report}) {
 const values = { ...env, [current.environment]: pair.INSTALLATION_KEY, [previous.environment]: pair.INSTALLATION_KEY_PREVIOUS };
 const extra = state ? ['--state', state] : [];
 await owner('secret', ['--set', current.binding, '--set', previous.binding, ...extra], values);
 await owner('rekey', extra, {...values, INSTALLATION_KEY_RETIRED:serializeRetired(retired)}, {notice:report});
 await owner('secret', ['--unset', previous.binding, ...extra], values);
 // The retired key stays private after its binding is read back absent.
 const retained = await savedSecrets(root, environment);
 delete retained.INSTALLATION_KEY_PREVIOUS;
 delete retained.INSTALLATION_KEY_REOPEN;
 const { writePrivateFile } = await shared('private-files.mjs');
 await writePrivateFile(join(root, savedSecretsFile(environment)), Object.entries(retained).map(([name, value]) => `${name}=${value}\n`).join(''));
}
