import { shared } from './shared.mjs';
import { readFile } from 'node:fs/promises';
import { contained } from './project.mjs';
import { refuse } from './errors.mjs';
import { parseAddress } from '../modules/mail/src/core/validation.mjs';
import { deliveryDeclarationSources } from './delivery-declarations.mjs';
import { validateRerConfig } from '../modules/mail/src/adapters/rer/contract.mjs';
import { validateMailSenders } from '../modules/delivery-producer/mail.mjs';
import { sourceMailSenders } from './deploy-variables.mjs';

const providers = ['resend', 'sendgrid', 'cloudflare', 'rer'];
const nativeCredential = { sendgrid: 'SENDGRID_API_KEY', resend: 'RESEND_API_KEY' };
// Preserve explicit empty adapter inputs: absence alone selects Mailgun's US default.
const mailgunInputs = new Set(['EMAIL_PROVIDER','EMAIL_API_KEY_NAME','EMAIL_FROM','MAILGUN_DOMAIN','MAILGUN_REGION','MAILGUN_SENDING_KEY']);
const supplied = (name,value) => present(value) || mailgunInputs.has(name) && typeof value === 'string';
const present = value => typeof value === 'string' && Boolean(value.trim());
// The sender forms the mail runtime sends from: a bare address or "Display Name <address>".
const sender = value => { try { parseAddress(value); return true; } catch { return false; } };
const SENDER = "MAIL_FROM (a real sender on your provider's verified domain; bare address or Display Name <address>)";
const fixtureSender = value => {
 if (!sender(value)) return false;
 const domain = parseAddress(value).email.toLowerCase().split('@')[1];
 return /(?:^|\.)(?:invalid|example|test|localhost)$/.test(domain)
  || /(?:^|\.)example\.(?:com|net|org)$/.test(domain);
};
const placeholderSender = value => {
 if (!sender(value)) return false;
 const { email } = parseAddress(value), [local, domain] = email.toLowerCase().split('@');
 return fixtureSender(value)
  || /^(?:your-?domain|your-?business|fake|placeholder|changeme)\./.test(domain)
  || /^(?:fake|placeholder|change-?me|replace-?me|your-?email|your-?name|you)(?:[+._-]|$)/.test(local);
};

// Packaging can declare inputs that a product's deploy adapter adds to the
// root declaration later. Read that source contract, never arbitrary ambient
// keys or the adapter's executable source, before any build or provider write.
export async function productionMail(root, declaration, env, declarationPath = 'deploy.json', adapter) {
 const bindings = { ...declaration.vars }, secrets = new Set(), publicInputs = new Set(), declaredProviders = new Set();
 const senders = [{ source: `${declarationPath} vars.MAIL_FROM`, value: declaration.vars?.MAIL_FROM }];
 senders.push(...await sourceMailSenders(root, adapter));
 let senderFix = `Edit vars.MAIL_FROM in ${declarationPath}`;
 const environmentFix = name => `Set ${name} in your environment or owned 0600 --env-file`;
 for (const secret of declaration.secrets ?? []) {
  secrets.add(secret.binding);
  if (supplied(secret.binding,env[secret.environment])) {
   if (secret.binding === 'MAIL_FROM') senders.push({ source: `${declarationPath} secrets.MAIL_FROM from ${secret.environment} (environment or --env-file)`, value: env[secret.environment] });
   bindings[secret.binding] = env[secret.environment];
   if (secret.binding === 'MAIL_FROM') senderFix = environmentFix(secret.environment);
  }
 }
 for (const [path, select] of deliveryDeclarationSources) {
  let text;
  try { text = await readFile(await contained(root, path, { optional: true }), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  let spec;
  try { spec = select(JSON.parse(text)); }
  catch { throw refuse(`Restore a valid mail deployment declaration at ${path}. Nothing was built or uploaded.`); }
  if (!spec) continue;
  senders.push({ source: `${path} publicVariables.MAIL_FROM`, value: spec.publicVariables?.MAIL_FROM });
  for (const name of spec.publicVariableNames ?? []) publicInputs.add(name);
  for (const [name, value] of Object.entries(spec.publicVariables ?? {})) {
   if (!(name in bindings) || name === 'MAIL_PROVIDER' && bindings[name] === 'later') {
    bindings[name] = value;
    if (name === 'MAIL_FROM') senderFix = `Edit publicVariables.MAIL_FROM in ${path}`;
   }
  }
  for (const name of [...(spec.secretNames ?? []), ...(spec.optionalSecretNames ?? [])]) {
   secrets.add(name);
   // A root secret's explicit environment-to-binding mapping wins.
   if (!declaration.secrets?.some(secret => secret.binding === name) && supplied(name,env[name])) {
    bindings[name] = env[name];
    if (name === 'MAIL_FROM') senders.push({ source: `${path} secret MAIL_FROM (environment or --env-file)`, value: env[name] });
    if (name === 'MAIL_FROM') senderFix = environmentFix(name);
   }
  }
  for (const provider of spec.mail?.providers ?? []) if (providers.includes(provider)) declaredProviders.add(provider);
 }
 for (const name of publicInputs) if (supplied(name,env[name])) {
  if (name === 'MAIL_FROM') senders.push({ source: 'public MAIL_FROM (environment or --env-file)', value: env[name] });
  bindings[name] = env[name];
  if (name === 'MAIL_FROM') senderFix = environmentFix(name);
 }
 try { validateMailSenders(senders); }
 catch (error) { throw refuse(`${error.message} Nothing was built or uploaded.`); }
 let senderIssue;
 if (present(bindings.MAIL_FROM) && (!sender(bindings.MAIL_FROM) || placeholderSender(bindings.MAIL_FROM))) {
  senderIssue = `MAIL_FROM is invalid or a placeholder sender. Replace it with a real sender address on your mail provider's verified domain (a bare address or Display Name <address>). ${senderFix}, then run rer deploy --dry-run again.`;
 }
 // EMAIL_* belongs to an edition's direct Mailgun adapter. Only declared
 // bindings, mapped inputs and inspected declared secrets can satisfy it.
 if(bindings.EMAIL_PROVIDER==='mailgun'){
  const {mailgunIssues}=await shared('email.mjs');
  const has=live=>key=>secrets.has(key)&&(typeof bindings[key]==='string'&&Boolean(bindings[key].trim())&&!/[^\x21-\x7e]/.test(bindings[key])||live.includes(key)&&!Object.hasOwn(bindings,key));
  const issues=live=>mailgunIssues(bindings,has(live));
  const invalidSender=present(bindings.EMAIL_FROM)&&(!sender(bindings.EMAIL_FROM)||placeholderSender(bindings.EMAIL_FROM));
  const emailSenderIssue=invalidSender?'EMAIL_FROM is invalid or a placeholder sender. Use a real sender on your Mailgun verified domain.':undefined;
  return {declared:true,required:true,senderIssue:emailSenderIssue,fixtureSender:fixtureSender(bindings.EMAIL_FROM),configured:(live=[])=>!emailSenderIssue&&!issues(live).length,canInspect:!emailSenderIssue&&issues(['MAILGUN_SENDING_KEY']).length===0,missing:[...issues([]),...(emailSenderIssue?[emailSenderIssue]:[])].join(', ')};
 }
 // An explicit EMAIL_PROVIDER must never fall through to a different MAIL_* provider.
 if('EMAIL_PROVIDER' in bindings&&!['later','resend','sendgrid','cloudflare','rer'].includes(bindings.EMAIL_PROVIDER))return {declared:true,configured:()=>false,canInspect:false,missing:'EMAIL_PROVIDER (resend, sendgrid, cloudflare, rer or mailgun)'};
 const provider = bindings.MAIL_PROVIDER;
 const deferred = !provider || provider === 'later';
 const choices = new Set(declaredProviders);
 if (deferred) for (const [name, key] of Object.entries(nativeCredential)) if (secrets.has(key)) choices.add(name);
 const selected = deferred ? [...choices] : providers.includes(provider) ? [provider] : [];
 const routes = selected.map(provider => {
  const credentialKeys = deferred && nativeCredential[provider] && !declaredProviders.has(provider) ? [nativeCredential[provider]]
   : ['MAIL_API_KEY', ...(nativeCredential[provider] ? [nativeCredential[provider]] : [])];
  // A seed's direct-provider adapter can declare the contract's shared provider
  // binding. Its explicit environment mapping (or live declared secret) still wins.
  if (nativeCredential[provider] && secrets.has('MAIL_PROVIDER_API_KEY')) credentialKeys.push('MAIL_PROVIDER_API_KEY');
  const declaredCredentials = credentialKeys.filter(key => secrets.has(key));
  // Only resend and sendgrid have a provider key of their own; cloudflare and rer send with MAIL_API_KEY alone.
  const providerKeys = (nativeCredential[provider] ? [nativeCredential[provider]] : []).filter(key => !declaredCredentials.includes(key));
  const credentialText = declaredCredentials.includes('MAIL_API_KEY') && providerKeys.length
    ? `${declaredCredentials.join(' or ')} (or ${providerKeys.join(' / ')})`
    : declaredCredentials.join(' or ') || credentialKeys.join(' or ');
  return live => {
   let relaySelected = true;
   if (provider === 'rer') try { validateRerConfig({ relayUrl: bindings.MAIL_RELAY_URL }); } catch { relaySelected = false; }
   const has = key => present(bindings[key]) || secrets.has(key) && live.includes(key);
   return [
    ...(!sender(bindings.MAIL_FROM) || senderIssue ? [senderIssue ?? SENDER] : []),
    ...(!credentialKeys.some(has) ? [credentialText] : []),
    ...(provider === 'cloudflare' && !has('MAIL_ACCOUNT_ID') ? ['MAIL_ACCOUNT_ID'] : []),
    ...(!relaySelected ? ['MAIL_RELAY_URL (assigned HTTPS relay URL)'] : []),
   ];
  };
 });
 return {
  declared: 'MAIL_PROVIDER' in bindings || publicInputs.has('MAIL_PROVIDER') || secrets.has('MAIL_API_KEY') || selected.length > 0,
  senderIssue,
  fixtureSender: fixtureSender(bindings.MAIL_FROM),
  configured: (live = []) => routes.some(missing => missing(live).length === 0),
  canInspect: sender(bindings.MAIL_FROM) && !senderIssue && routes.length > 0,
  missing: routes.length ? routes.map(missing => missing([]).join(', ')).join(' or ') : [
   'MAIL_PROVIDER (resend, sendgrid, cloudflare or rer)',
   ...(!sender(bindings.MAIL_FROM) || senderIssue ? [senderIssue ?? SENDER] : []),
   'MAIL_API_KEY',
  ].join(', '),
 };
}
