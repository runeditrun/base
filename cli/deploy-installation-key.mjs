import { savedSecrets, saveSecrets, savedSecretsFile, liveSecretNames } from './deploy-secrets.mjs';
import { refuse } from './errors.mjs';
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
 const pair = { INSTALLATION_KEY: saved.INSTALLATION_KEY_PREVIOUS ? saved.INSTALLATION_KEY : env[current.environment], INSTALLATION_KEY_PREVIOUS: saved.INSTALLATION_KEY_PREVIOUS ?? saved.INSTALLATION_KEY };
 if (!pair.INSTALLATION_KEY || pair.INSTALLATION_KEY === pair.INSTALLATION_KEY_PREVIOUS) throw refuse('Installation key rotation requires distinct current and previous keys.');
 addSecrets(Object.values(pair));
 await saveSecrets(root, environment, pair);
 const values = { ...env, [current.environment]: pair.INSTALLATION_KEY, [previous.environment]: pair.INSTALLATION_KEY_PREVIOUS };
 const extra = state ? ['--state', state] : [];
 await owner('secret', ['--set', current.binding, '--set', previous.binding, ...extra], values);
 await owner('rekey', extra, values);
 await owner('secret', ['--unset', previous.binding, ...extra], values);
 // Retirement was read back and recorded before the old key leaves custody.
 const retained = await savedSecrets(root, environment);
 delete retained.INSTALLATION_KEY_PREVIOUS;
 const { writePrivateFile } = await shared('private-files.mjs');
 await writePrivateFile(join(root, savedSecretsFile(environment)), Object.entries(retained).map(([name, value]) => `${name}=${value}\n`).join(''));
 report('Rotated INSTALLATION_KEY, resealed every dependency key, and removed INSTALLATION_KEY_PREVIOUS after verifying the owned Worker.');
}
