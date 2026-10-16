import { shared } from './shared.mjs';

// What a deployment's declaration says each value is. A value prints in full only
// when the declaration names it a non-secret setting: a declared var, the origin
// variable and its setting, a setup field that is not a secret, or a name in
// "publicSettings". Anything the declaration calls a secret, any credential-named
// key and any other --env-file value stays redacted.
const PRIVATE_KEYS = ['CLOUDFLARE_ACCOUNT_ID'];

export async function settingKinds({ declaration = {}, setupManifest } = {}) {
 const { credentialName, credentialUrl, credentialValues } = await shared('redaction.mjs');
 const secrets = Array.isArray(declaration.secrets) ? declaration.secrets : [];
 const names = list => (Array.isArray(list) ? list : []).filter(name => typeof name === 'string');
 const fields = Array.isArray(setupManifest?.fields) ? setupManifest.fields : [];
 const secret = new Set([...PRIVATE_KEYS, ...secrets.flatMap(item => [item?.binding, item?.environment]), ...fields.filter(field => field?.kind === 'secret').map(field => field.name)].filter(Boolean));
 const open = new Set([...Object.keys(declaration.vars ?? {}), declaration.originVar, declaration.publicOriginSetting, ...names(declaration.publicSettings), ...fields.filter(field => field?.kind !== 'secret').map(field => field?.name)].filter(name => name && !secret.has(name)));
 // A declared setting is exempt from the key-name heuristic (AUTH_ORIGIN is a
 // name, not a credential), never when its value carries credentials itself.
 const shown = (key, value) => open.has(key) && typeof value === 'string' && !credentialUrl(value);
 return {
  shown,
  // The values to keep out of output, from every key that is not shown.
  privateValues: env => Object.entries(env).flatMap(([key, value]) => typeof value !== 'string' || shown(key, value) ? [] : secret.has(key) ? (value ? [value] : []) : credentialValues({ [key]: value })),
  // Keys the deploy hides by default and the person may declare.
  undeclared: keys => keys.filter(key => !open.has(key) && !secret.has(key) && !credentialName(key)),
 };
}

// The declaration and setup manifest the deploy will read, loaded early so the
// redaction knows each value's kind. A project that cannot yield them yet
// declares nothing, so every --env-file value stays redacted and the deploy
// itself reports the real error.
export async function declaredSettings(project) {
 let declaration, path, setupManifest = project.setupManifest;
 if (!project.adapter) return {};
 try { ({ path, value: declaration } = await (await import('./deploy-command.mjs')).declarationFor(project.root, project.adapter)); } catch { return {}; }
 if (!setupManifest && project.adapter.setup) {
  try { setupManifest = (await (await shared('setup-manifest.mjs')).loadInstallerSeed(project.root, project.adapter)).manifest; } catch { /* the lifecycle reports an invalid manifest */ }
 }
 return { declaration, path, setupManifest };
}

export function undeclaredNotice(names, path) {
 return `Undeclared --env-file settings stay out of rer's output: ${names.join(', ')}. To print one, declare it as a non-secret setting: add its name to "publicSettings" in ${path}.`;
}
