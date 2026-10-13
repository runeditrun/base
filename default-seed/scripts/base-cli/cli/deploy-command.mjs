import { readFile, readdir } from 'node:fs/promises';
import { contained } from './project.mjs';
import { invalid, refuse, RerError } from './errors.mjs';
import { ownerDeploy } from './deploy.mjs';
import { deployEnvironment, deployAgain } from './deploy-inputs.mjs';
import { claimHostedOwner } from './deploy-owner.mjs';
import { observeOwner } from './deploy-observation.mjs';
import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { localOnlyBinding, ownerWorkerName } from '../modules/deploy-kit/owner.mjs';
import { refuseLocalModels } from '../modules/deploy-kit/local-only.mjs';
import { shared } from './shared.mjs';

export function validateDeployOptions(options) {
 const changes = [options.remove && '--remove', options.setSecret && '--set-secret', options.unsetSecret && '--unset-secret'].filter(Boolean);
 if (changes.length > 1 || changes.length && options.dryRun) throw invalid(`Use ${changes.join(', ')}${options.dryRun ? ' and --dry-run' : ''} on separate runs.`);
 if (options.remove && !options.yes) throw invalid(`${deployAgain(options)} --remove deletes this environment's Worker and every D1, R2, KV and queue rer created for it, with their data. Add --yes to confirm.`);
}

// An explicit adapter declaration wins. Older hooks use a conventional root
// declaration; discover it by its schema, never by seed identity or hook source.
async function declarationFor(root, adapter) {
 const declared = adapter.deployDeclaration ?? adapter.deploy?.declaration;
 const paths = declared ? [declared] : (await readdir(root)).filter(path => path.endsWith('.json') && path !== adapter.site?.declaration);
 const matches = [];
 for (const path of paths) {
  let value;
  try { value = JSON.parse(await readFile(await contained(root, path), 'utf8')); }
  catch (error) { if (declared) throw error; continue; }
  if (declared || value?.version === 1 && typeof value.project === 'string' && typeof value.compatibilityDate === 'string') matches.push({ path, value });
 }
 if (matches.length !== 1) throw refuse('A single owner-account deploy declaration is required. Declare deployDeclaration on the adapter; missing or ambiguous declarations cannot be used safely.');
 return matches[0];
}

export async function deployCommand(context) {
 const { adapter, root, options, store, setupManifest, linkDependencies, localOnlyKeys = [] } = context;
 validateDeployOptions(options);
 try { await refuseLocalModels(root); } catch { throw refuse('Deploy refuses the local-only key file .rer/local/models.json. Remove live-dev credentials before deployment.'); }
 const { path, value: declaration } = await declarationFor(root, adapter);
 ownerWorkerName(declaration.project, options.environment ?? 'production');
 const local = localOnlyBinding(declaration, localOnlyKeys);
 if (local) throw refuse(`${path} names the local-only key ${local} as a deploy binding or secret. Remove it; local dev keys never reach a deployment.`);
 // Custom hooks historically ignored these flags. Only the ownership controller
 // may perform them; neither a build nor a custom upload runs here.
 if (options.remove || options.setSecret || options.unsetSecret) return ownerDeploy(path, adapter)(context);
 if (adapter.deploy.managesHostedOwner) return adapter.deploy(context);
 const { env, supplied } = await deployEnvironment({ root, options, declaration, setupManifest, settings: adapter.settings, localOnlyKeys });
 const { createRedaction, credentialValues } = await shared('redaction.mjs');
 const redaction = createRedaction();
 const addSecret = value => { redaction.addSecrets([value]); store.addSecrets?.([value]); };
 for (const value of [...credentialValues(env), env.CLOUDFLARE_ACCOUNT_ID, ...(declaration.secrets ?? []).map(item => env[item.environment])].filter(Boolean)) addSecret(value);
 const command = (verb, extra = [], values = env) => owner([verb, '--declaration', path, '--environment', options.environment ?? 'production', ...extra], values, { cwd: root, localOnlyKeys });
 let recorded;
 const inspect = async () => (recorded = await command('inspect'));
 let observedClaims = [];
 let deployed, claimed, linked = false, linkResult, step = 'custom deploy';
 const link = async token => { if (!linked) { const state = await inspect(); linkResult = await linkDependencies?.(state.origin, token); linked = true; } return linkResult; };
 try {
  return await observeOwner({ paths: ['/auth/bootstrap', adapter.hooks?.owner?.path, setupManifest?.steps?.find(item => item.type === 'owner-claim')?.path].filter(Boolean), inspect, beforeClaim: link, addSecret }, async claims => {
   observedClaims = claims;
   const saved = { ...process.env };
   try {
    Object.assign(process.env, env);
    deployed = await adapter.deploy({ ...context, linkDependencies: async (_origin, token) => link(token) });
   } finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    Object.assign(process.env, saved);
   }
   if (options.dryRun) return deployed;
   if (!deployed?.deployed) throw new Error('custom-deploy-did-not-confirm-deployment');
   step = 'verify recorded deployment';
   const state = await inspect();
   if (state.origin !== deployed.origin) throw new Error('owner-claim-origin-mismatch');
   if (claims.some(item => !item.outcome)) throw new Error('owner-claim-failed');
   claimed = claims.at(-1)?.outcome;
   step = 'claim owner';
   claimed = await claimHostedOwner({ hook: adapter.hooks?.owner, setupManifest, declaration, deployed: { ...state, owner: claimed, observedOwner: () => claims.at(-1)?.outcome }, env, supplied, secret: (extra, values) => command('secret', extra, values), addSecret, beforeClaim: link, recordClaim: outcome => command('record-owner', ['--outcome', outcome]), store, signal: context.signal });
   if (!linked) await linkDependencies?.(state.origin);
   if (claimed) store.report(`${claimed === 'claimed' ? 'Claimed the hosted owner' : 'The hosted owner was already claimed and was kept'}; the one-time setup token was removed. Sign in by email at ${state.origin}.`);
   return { ...deployed, ...(claimed ? { owner: claimed } : {}), dependenciesLinked: true };
  });
 } catch (error) {
  const again = deployAgain(options);
  if (error instanceof RerError && !deployed?.deployed && !recorded) { error.message = store.redact?.(redaction.redact(error.message)) ?? redaction.redact(error.message); throw error; }
  const { commandFailure } = await shared('failures.mjs');
  const outcome = error.owner ?? claimed ?? observedClaims.at(-1)?.outcome;
  const state = deployed?.deployed || recorded ? `The application is deployed at ${deployed?.origin ?? recorded.origin}; ${outcome ? `owner ${outcome}` : 'owner claim is not confirmed'}; setup token retirement is not confirmed.` : 'The custom deploy did not finish; inspect its deployment record before recovery.';
  const redact = value => store.redact?.(redaction.redact(value)) ?? redaction.redact(value);
  throw commandFailure(redact(`${state} Failed at ${step}: ${error.message}${error.cause ? ` (${error.cause})` : ''}. Fix the cause and run ${again} again using the same environment credentials. ${outcome ? `To retire the token without rebuilding: ${again} --unset-secret ${setupManifest?.steps?.find(item => item.type === 'owner-claim')?.tokenField ?? 'SETUP_TOKEN'}.` : ''}`));
 }
}
