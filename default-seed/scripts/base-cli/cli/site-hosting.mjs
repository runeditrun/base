import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { RerError } from './errors.mjs';
import { declarationFor } from './deploy-command.mjs';
import { deployGuide, deployPermissions } from './deploy-needs.mjs';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { ownerPlatforms, ownerWorkerName } from '../modules/deploy-kit/owner.mjs';

// What the run site's /docs/hosting tells a person about putting this seed on
// their own Cloudflare account, read from the declarations rer deploy reads: the
// deploy declaration, the setup manifest and the mail delivery declarations. It
// holds environment names, permissions and counts, never a value. `hosting` is
// null, with the reason, when rer deploy could not put this seed on Workers from
// them; the page then offers Run Edit Run's help alone. Never throws for what a
// seed declares, so a declaration gap never stops rer dev's run site.
const OWN = ['resend', 'sendgrid', 'cloudflare'];
const NATIVE = { resend: 'RESEND_API_KEY', sendgrid: 'SENDGRID_API_KEY' };

class Gap extends Error {}
async function json(root, path) {
 let text;
 try { text = await readFile(await contained(root, path, { optional: true }), 'utf8'); }
 catch (error) { if (error.code === 'ENOENT') return undefined; throw new Gap(`${path} cannot be read`); }
 try { return JSON.parse(text); } catch { throw new Gap(`${path} is not valid JSON`); }
}

/** { hosting } for /docs/hosting, or { hosting: null, reason } when the seed does not deploy to Workers from its declarations. */
export async function siteHosting({ root, adapter }) {
 if (typeof adapter?.deploy !== 'function') return { hosting: null, reason: 'the command adapter has no deploy' };
 try { return { hosting: await read(root, adapter) }; }
 catch (error) {
  // rer deploy's own refusals of the declaration (missing, ambiguous, invalid) are gaps too.
  if (error instanceof Gap || error instanceof RerError || /^[a-z]+(?:-[a-z0-9]+)+$/.test(error?.message ?? '')) return { hosting: null, reason: error.message };
  throw error;
 }
}

async function read(root, adapter) {
 const { path, value: declaration } = await declarationFor(root, adapter);
 if (!ownerPlatforms(declaration).includes('workers')) throw new Gap(`${path} does not deploy to Workers`);
 const guide = deployGuide(declaration);
 const manifest = await json(root, adapter.setup?.manifestFile ?? 'rer-setup.json') ?? {};
 const fields = new Map((Array.isArray(manifest.fields) ? manifest.fields : []).map(field => [field?.name, field]));
 const steps = Array.isArray(manifest.steps) ? manifest.steps : [], claim = steps.find(step => step?.type === 'owner-claim');
 const vars = declaration.vars ?? {}, secrets = (Array.isArray(declaration.secrets) ? declaration.secrets : []).filter(item => item?.binding && item.environment);
 // What the deploy file can set, by binding: a declared secret under its environment name,
 // and a mail declaration's inputs under their own (productionMail reads the same).
 const input = new Map(secrets.map(item => [item.binding, item.environment])), offered = new Set();
 for (const [source, select] of deliveryDeclarationSources) {
  const spec = select(await json(root, source));
  if (!spec) continue;
  for (const name of [...(spec.publicVariableNames ?? []), ...(spec.secretNames ?? []), ...(spec.optionalSecretNames ?? [])]) if (!input.has(name)) input.set(name, name);
  for (const provider of spec.mail?.providers ?? []) offered.add(provider);
 }
 for (const option of fields.get('MAIL_PROVIDER')?.options ?? []) offered.add(option?.value);
 const sso = Array.isArray(manifest.dependencies) && manifest.dependencies.some(item => item?.interface === 'oidc-provider@1');
 let mail;
 if (claim || sso || 'MAIL_PROVIDER' in vars || input.has('MAIL_PROVIDER') || input.has('MAIL_API_KEY')) {
  const fixedProvider = input.has('MAIL_PROVIDER') ? undefined : vars.MAIL_PROVIDER;
  if (!input.has('MAIL_PROVIDER') && !OWN.includes(fixedProvider)) throw new Gap(`${path} fixes MAIL_PROVIDER to ${JSON.stringify(fixedProvider ?? null)} and the deploy file cannot choose one`);
  // The provider key the declaration requires, else one it accepts.
  const keys = ['MAIL_API_KEY', 'MAIL_PROVIDER_API_KEY', NATIVE[fixedProvider]].filter(Boolean), needed = name => secrets.some(item => item.binding === name && !item.optional);
  const key = input.get(keys.find(needed)) ?? keys.map(name => input.get(name)).find(Boolean);
  if (!key) throw new Gap(`${path} declares no input for the mail provider's API key`);
  mail = { providers: OWN.filter(provider => offered.has(provider)), ...(input.has('MAIL_PROVIDER') ? { provider: input.get('MAIL_PROVIDER') } : { fixedProvider }),
   ...(input.has('MAIL_FROM') ? { from: input.get('MAIL_FROM') } : {}), key, ...(input.has('MAIL_ACCOUNT_ID') ? { accountId: input.get('MAIL_ACCOUNT_ID') } : {}) };
 }
 // rer deploy generates the setup manifest's generated secrets and keeps the installation keys; every other
 // required secret the owner supplies once, under its environment name (neededForRealDeploy lists the same).
 const generated = new Set([...fields.values()].filter(field => field?.kind === 'secret' && field.generate).map(field => field.name));
 const ownerEmail = claim?.emailField && input.get(claim.emailField);
 const shown = new Set([ownerEmail, mail?.provider, mail?.from, mail?.key, mail?.accountId].filter(Boolean)), required = [];
 for (const item of secrets) {
  if (item.optional || generated.has(item.binding) || ['INSTALLATION_KEY_PREVIOUS', 'MAIL_RELAY_URL'].includes(item.binding) || shown.has(item.environment) || required.some(entry => entry.name === item.environment)) continue;
  const field = fields.get(item.binding);
  required.push({ name: item.environment, ...(typeof field?.label === 'string' ? { label: field.label } : {}), ...(typeof field?.help === 'string' ? { help: field.help } : {}) });
 }
 const count = key => Array.isArray(declaration[key]) ? declaration[key].length : 0;
 return {
  declaration: path,
  // A custom deploy hook may name and place its Worker itself: only rer's own deploy's address is known.
  ...(adapter.deploy.managesHostedOwner === true ? { worker: ownerWorkerName(declaration.project, 'production') } : {}),
  permissions: deployPermissions(declaration),
  resources: { d1: count('d1'), r2: count('r2'), kv: count('kv'), queues: count('queues'), durableObjects: count('durableObjects'), crons: count('crons') },
  ...(ownerEmail ? { ownerEmail } : {}),
  ...(mail ? { mail } : {}),
  required,
  ...(guide ? { guide } : {}),
 };
}
