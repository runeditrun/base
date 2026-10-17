import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { refuse } from './errors.mjs';
import { parseAddress } from '../modules/mail/src/core/validation.mjs';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { validateRerConfig } from '../modules/mail/src/adapters/rer/contract.mjs';

const providers = ['resend', 'sendgrid', 'cloudflare', 'rer'];
const nativeCredential = { sendgrid: 'SENDGRID_API_KEY', resend: 'RESEND_API_KEY' };
const present = value => typeof value === 'string' && Boolean(value.trim());
// The sender forms the mail runtime sends from: a bare address or "Display Name <address>".
const sender = value => { try { parseAddress(value); return true; } catch { return false; } };
const SENDER = 'MAIL_FROM (billing@example.com or Your Business <billing@example.com>)';

// Packaging can declare inputs that a product's deploy adapter adds to the
// root declaration later. Read that source contract, never arbitrary ambient
// keys or the adapter's executable source, before any build or provider write.
export async function productionMail(root, declaration, env) {
 const bindings = { ...declaration.vars }, secrets = new Set(), publicInputs = new Set(), declaredProviders = new Set();
 for (const secret of declaration.secrets ?? []) {
  secrets.add(secret.binding);
  if (present(env[secret.environment])) bindings[secret.binding] = env[secret.environment];
 }
 for (const [path, select] of deliveryDeclarationSources) {
  let text;
  try { text = await readFile(await contained(root, path, { optional: true }), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  let spec;
  try { spec = select(JSON.parse(text)); }
  catch { throw refuse(`Restore a valid mail deployment declaration at ${path}. Nothing was built or uploaded.`); }
  if (!spec) continue;
  for (const name of spec.publicVariableNames ?? []) publicInputs.add(name);
  for (const [name, value] of Object.entries(spec.publicVariables ?? {})) {
   if (!(name in bindings) || name === 'MAIL_PROVIDER' && bindings[name] === 'later') bindings[name] = value;
  }
  for (const name of [...(spec.secretNames ?? []), ...(spec.optionalSecretNames ?? [])]) {
   secrets.add(name);
   // A root secret's explicit environment-to-binding mapping wins.
   if (!declaration.secrets?.some(secret => secret.binding === name) && present(env[name])) bindings[name] = env[name];
  }
  for (const provider of spec.mail?.providers ?? []) if (providers.includes(provider)) declaredProviders.add(provider);
 }
 for (const name of publicInputs) if (present(env[name])) bindings[name] = env[name];
 const provider = bindings.MAIL_PROVIDER;
 const deferred = !provider || provider === 'later';
 const choices = new Set(declaredProviders);
 if (deferred) for (const [name, key] of Object.entries(nativeCredential)) if (secrets.has(key)) choices.add(name);
 const selected = deferred ? [...choices] : providers.includes(provider) ? [provider] : [];
 const routes = selected.map(provider => {
  const credentialKeys = deferred && nativeCredential[provider] && !declaredProviders.has(provider) ? [nativeCredential[provider]]
   : ['MAIL_API_KEY', ...(nativeCredential[provider] ? [nativeCredential[provider]] : [])];
  const declaredCredentials = credentialKeys.filter(key => secrets.has(key));
  return live => {
   let relaySelected = true;
   if (provider === 'rer') try { validateRerConfig({ relayUrl: bindings.MAIL_RELAY_URL }); } catch { relaySelected = false; }
   const has = key => present(bindings[key]) || secrets.has(key) && live.includes(key);
   return [
    ...(!sender(bindings.MAIL_FROM) ? [SENDER] : []),
    ...(!credentialKeys.some(has) ? [declaredCredentials.join(' or ') || credentialKeys.join(' or ')] : []),
    ...(provider === 'cloudflare' && !has('MAIL_ACCOUNT_ID') ? ['MAIL_ACCOUNT_ID'] : []),
    ...(!relaySelected ? ['MAIL_RELAY_URL (assigned HTTPS relay URL)'] : []),
   ];
  };
 });
 return {
  declared: 'MAIL_PROVIDER' in bindings || publicInputs.has('MAIL_PROVIDER') || secrets.has('MAIL_API_KEY') || selected.length > 0,
  configured: (live = []) => routes.some(missing => missing(live).length === 0),
  canInspect: sender(bindings.MAIL_FROM) && routes.length > 0,
  missing: routes.length ? routes.map(missing => missing([]).join(', ')).join(' or ') : [
   'MAIL_PROVIDER (resend, sendgrid, cloudflare or rer)',
   ...(!sender(bindings.MAIL_FROM) ? [SENDER] : []),
   'MAIL_API_KEY',
  ].join(', '),
 };
}
