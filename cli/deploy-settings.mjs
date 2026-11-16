import { shared } from './shared.mjs';

// What a deployment's declaration says each value is. A value prints in full only
// when the declaration names it a non-secret setting: a declared var, the origin
// variable and its setting, a setup field that is not a secret, or a name in
// "publicSettings". Secret transport alone does not make an explicitly public
// setting private. Credential bindings, private setup fields and undeclared
// --env-file values stay redacted.
const PRIVATE_KEYS = ['CLOUDFLARE_ACCOUNT_ID'];

export async function settingKinds({ declaration = {}, setupManifest } = {}) {
 const { credentialName, credentialValue, credentialValues } = await shared('redaction.mjs');
 const secrets = Array.isArray(declaration.secrets) ? declaration.secrets : [];
 const names = list => (Array.isArray(list) ? list : []).filter(name => typeof name === 'string');
 const fields = Array.isArray(setupManifest?.fields) ? setupManifest.fields : [];
 const privateFields = new Set([...PRIVATE_KEYS, ...fields.filter(field => field?.kind === 'secret').map(field => field.name)]);
 // Select fields describe public choices. Other transported inputs need an
 // explicit publicSettings declaration; an owner email is still private.
 const publicTransport = new Set([...names(declaration.publicSettings), ...fields.filter(field => field?.kind === 'select').map(field => field.name)]);
 const publicBindings = secrets.filter(item => publicTransport.has(item?.binding) &&
  [item.binding, item.environment].every(name => name && !privateFields.has(name) && !credentialName(name)));
 const secret = new Set([...privateFields, ...secrets.filter(item => !publicBindings.includes(item)).flatMap(item => [item?.binding, item?.environment])].filter(Boolean));
 const open = new Set([...Object.keys(declaration.vars ?? {}), declaration.originVar, declaration.publicOriginSetting, ...names(declaration.publicSettings), ...fields.filter(field => field?.kind !== 'secret').map(field => field?.name), ...publicBindings.flatMap(item => [item.binding, item.environment])].filter(name => name && !secret.has(name)));
 // Public names never exempt a credential-shaped value from masking.
 const shown = (key, value) => open.has(key) && typeof value === 'string' && !credentialValue(value);
 return {
  shown,
  // The values to keep out of output, from every key that is not shown.
  privateValues: env => Object.entries(env).flatMap(([key, value]) => typeof value !== 'string' || shown(key, value) ? [] : (secret.has(key) || credentialValue(value)) ? (value ? [value] : []) : credentialValues({ [key]: value })),
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

// Opt-in transport for a public choice with an explicit reset value. Keep this
// distinct from setup select fields: old declarations keep their exact plans.
export async function switchableDefaults(declaration, setupManifest) {
 const kinds = await settingKinds({ declaration, setupManifest });
 return Object.fromEntries((Array.isArray(declaration.secrets) ? declaration.secrets : []).filter(item =>
  item?.optional === true && Array.isArray(declaration.publicSettings) && declaration.publicSettings.includes(item.binding) &&
  kinds.shown(item.binding, declaration.vars?.[item.binding]) && kinds.shown(item.environment, declaration.vars?.[item.binding])
 ).map(item => [item.binding, declaration.vars[item.binding]]));
}

export function switchableDeclarationHelp(path = 'deploy.json') {
 return `For a switchable public setting such as MAIL_PROVIDER, declare its name in publicSettings, its default in vars, and a secrets entry with binding, environment and optional: true in ${path}; keep the same public default in Wrangler vars. Credentials remain secrets.`;
}
