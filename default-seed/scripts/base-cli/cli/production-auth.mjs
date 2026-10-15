import { refuse } from './errors.mjs';
import { mailbox } from './parse.mjs';
import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { hookState } from './deploy-hook-record.mjs';
import { savedSetupAnswers } from './setup-answers.mjs';
import { validateRerConfig } from '../modules/mail/src/adapters/rer/contract.mjs';

// Validate the shared email/identity contract using the bindings that will reach
// the runtime. Independently authored authentication remains the adapter's job.
export async function requireProductionAuth({ root, declaration, env, setupManifest, setupSeed, adapter, declarationPath, options = {} }) {
 const dependencies = setupManifest?.dependencies?.filter(item => item.interface === 'oidc-provider@1') ?? [];
 const bindings = { ...declaration.vars };
 for (const secret of declaration.secrets ?? []) if (env[secret.environment]?.trim()) bindings[secret.binding] = env[secret.environment];
 if (!setupManifest?.steps?.some(step => step.type === 'owner-claim') && !dependencies.length && !('MAIL_PROVIDER' in bindings) && !declaration.secrets?.some(item => item.binding === 'MAIL_API_KEY')) return;
 const provider = bindings.MAIL_PROVIDER;
 let mailSelected = ['resend', 'sendgrid', 'cloudflare', 'rer'].includes(provider) && mailbox(bindings.MAIL_FROM);
 let relaySelected = true;
 if (provider === 'rer') {
  try { validateRerConfig({ relayUrl: bindings.MAIL_RELAY_URL }); } catch { relaySelected = false; mailSelected = false; }
 }
 // Secrets arrive under the seed's declared runtime binding, which need not
 // be the shared facade's MAIL_API_KEY (for example native SendGrid auth).
 const credentialKeys = ['MAIL_API_KEY', ...(provider === 'sendgrid' ? ['SENDGRID_API_KEY'] : [])];
 const declaredCredentials = credentialKeys.filter(key => declaration.secrets?.some(item => item.binding === key));
 const required = provider === 'cloudflare' ? ['MAIL_ACCOUNT_ID'] : [];
 const hasMailSecrets = live => credentialKeys.some(key => bindings[key]?.trim() || live.includes(key))
  && required.every(key => bindings[key]?.trim() || live.includes(key));
 if (mailSelected && hasMailSecrets([])) return;
 if (mailSelected && !options.dryRun && declarationPath) {
  try {
   const state = await hookState(root, options.environment ?? 'production');
   const existing = await owner(['inspect', '--declaration', declarationPath, '--environment', options.environment ?? 'production', ...(state ? ['--state', state] : [])], env, { cwd: root, localOnlyKeys: adapter?.localOnlyKeys });
   if (hasMailSecrets(existing.liveSecrets)) return;
  } catch (error) {
   if (!['missing-owner-receipt', 'missing-input'].includes(error.message)) throw refuse(`Production sign-in could not verify the existing deployment and its mail secrets${/^[a-z][a-z0-9-]{0,80}$/.test(error.message)?` (${error.message})`:''}. Restore provider access and the owned deployment record before retrying.`);
  }
 }
 const answers = setupSeed ? await savedSetupAnswers({ root, adapter, setupManifest }, setupSeed.model) : undefined;
 // Link approval and live post-link status are checked by linkDependencies;
 // selecting an issuer never bypasses that existing setup requirement.
 if (dependencies.some(item => {
  try { const value = answers?.[item.address] ?? bindings[item.address], issuer = new URL(value); return issuer.protocol === 'https:' && issuer.origin === value && !issuer.username && !issuer.password; } catch { return false; }
 })) return;
 const missing = [
  ...(!['resend', 'sendgrid', 'cloudflare', 'rer'].includes(provider) ? ['MAIL_PROVIDER (resend, sendgrid, cloudflare or rer)'] : []),
  ...(!mailbox(bindings.MAIL_FROM) ? ['MAIL_FROM'] : []),
  ...(!credentialKeys.some(key => bindings[key]?.trim()) ? [declaredCredentials.join(' or ') || credentialKeys.join(' or ')] : []),
  ...required.filter(key => !bindings[key]?.trim()),
  ...(!relaySelected ? ['MAIL_RELAY_URL (assigned HTTPS relay URL)'] : []),
 ];
 throw refuse(`Production sign-in is not configured. Configure outbound email; missing or invalid: ${missing.join(', ')}. Or select and approve an Auth SSO install through the declared oidc-provider@1 setup dependency. Local dev and demo use automatic RER_OPEN sign-in. Nothing was built or uploaded.`);
}
