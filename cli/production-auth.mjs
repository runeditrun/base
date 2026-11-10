import { refuse } from './errors.mjs';
import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { hookState } from './deploy-hook-record.mjs';
import { savedSetupAnswers } from './setup-answers.mjs';
import { productionMail, mailOffSignInCommand } from './production-mail.mjs';

// What a deploy says when outbound email is deliberately off: the state and the way in. A seed that
// declares its mail credential secrets (`mail.credentialSecretNames`) gets this line only when it is
// true: with the Worker's bound secret names in `live`, a bound mail secret is named instead, and
// without them (a dry run reads no secrets) the line says the bound secrets were not read.
export function mailOffNotice({ signIn, credentialNames = [] }, environment = 'production', live) {
 if (credentialNames.length && Array.isArray(live)) {
  const bound = credentialNames.filter(name => live.includes(name));
  if (bound.length) return `Outbound email is configured by the secrets bound on this environment's Worker: ${bound.join(', ')} (names only; values are never printed). This deploy's MAIL_PROVIDER=none setting does not remove them; turn mail off with rer deploy --environment ${environment} --unset-secret and these names. Sign in without mail with \`${signIn}\` for the ${environment} environment, from this checkout with the Cloudflare credentials that deployed it.`;
 }
 const unread = credentialNames.length && !Array.isArray(live) ? ` The bound secrets were not read: if one of ${credentialNames.join(', ')} is bound on the Worker, outbound email is configured by it.` : '';
 return `Outbound email is off (MAIL_PROVIDER=none): no mail credential is bound and this installation sends nothing. Sign in without mail with \`${signIn}\` for the ${environment} environment, from this checkout with the Cloudflare credentials that deployed it. Turn mail on later with rer deploy --environment ${environment} --set-secret and the provider inputs.${unread}`;
}

// Validate the shared email/identity contract using the bindings that will reach
// the runtime. Independently authored authentication remains the adapter's job.
// `mailOffSignIn` names the seed's mail-less sign-in command when the caller holds it apart
// from `adapter` (the owner deploy runs on the lifecycle, the seed declares on its command adapter).
export async function requireProductionAuth({ root, declaration, env, setupManifest, setupSeed, adapter, declarationPath, options = {}, mailOffSignIn: declaredSignIn = mailOffSignInCommand(adapter) }) {
 const dependencies = setupManifest?.dependencies?.filter(item => item.interface === 'oidc-provider@1') ?? [];
 const bindings = { ...declaration.vars };
 for (const secret of declaration.secrets ?? []) if (env[secret.environment]?.trim()) bindings[secret.binding] = env[secret.environment];
 const mail = await productionMail(root, declaration, env, declarationPath, adapter, declaredSignIn);
 if (!setupManifest?.steps?.some(step => step.type === 'owner-claim') && !dependencies.length && !mail.declared) return;
 // MAIL_PROVIDER=none is accepted only for a seed that declares how its owner signs in without mail.
 const mailOffSignIn = mail.off ? declaredSignIn : undefined;
 if (mailOffSignIn) {
  if (mail.offConflicts.length) throw refuse(`MAIL_PROVIDER=none turns outbound email off, and ${mail.offConflicts.join(', ')} would bind a way to send. Remove ${mail.offConflicts.length > 1 ? 'them' : 'it'} or choose a mail provider. Nothing was built or uploaded.`);
  return { mailOff: { signIn: mailOffSignIn, credentialNames: mail.credentialNames } };
 }
 if (mail.senderIssue && options.verb === 'deploy' && !(options.dryRun && mail.fixtureSender)) throw refuse(`${mail.senderIssue} Nothing was built or uploaded.`);
 if (mail.configured()) return;
 if (mail.canInspect && !options.dryRun && declarationPath) {
  try {
   const state = await hookState(root, options.environment ?? 'production');
   const existing = await owner(['inspect', '--declaration', declarationPath, '--environment', options.environment ?? 'production', ...(state ? ['--state', state] : [])], env, { cwd: root, localOnlyKeys: adapter?.localOnlyKeys });
   if (mail.configured(existing.liveSecrets)) return;
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
 // A dry run goes ahead without the mail inputs and lists them as needed for a real deploy.
 if (options.dryRun) return { signIn: `${mail.missing}${dependencies.length ? ', or an approved Auth SSO install' : ''}` };
 throw refuse(`Production sign-in is not configured. Configure outbound email; missing or invalid: ${mail.missing}. Or select and approve an Auth SSO install through the declared oidc-provider@1 setup dependency. Local dev and demo use automatic RER_OPEN sign-in. Nothing was built or uploaded.`);
}
