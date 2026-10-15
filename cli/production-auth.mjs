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
 if (provider === 'rer') {
  try { validateRerConfig({ relayUrl: bindings.MAIL_RELAY_URL }); } catch { mailSelected = false; }
 }
 const required = ['MAIL_API_KEY', ...(provider === 'cloudflare' ? ['MAIL_ACCOUNT_ID'] : [])];
 if (mailSelected && required.every(key => bindings[key]?.trim())) return;
 if (mailSelected && !options.dryRun && declarationPath) {
  try {
   const state = await hookState(root, options.environment ?? 'production');
   const existing = await owner(['inspect', '--declaration', declarationPath, '--environment', options.environment ?? 'production', ...(state ? ['--state', state] : [])], env, { cwd: root, localOnlyKeys: adapter?.localOnlyKeys });
   if (required.every(key => bindings[key]?.trim() || existing.liveSecrets.includes(key))) return;
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
 throw refuse('Production sign-in is not configured. Configure outbound email (MAIL_PROVIDER, MAIL_FROM and MAIL_API_KEY; Cloudflare also needs MAIL_ACCOUNT_ID, RER needs MAIL_RELAY_URL), or select and approve an Auth SSO install through the declared oidc-provider@1 setup dependency. Local dev and demo use automatic RER_OPEN sign-in. Nothing was built or uploaded.');
}
