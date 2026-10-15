import { requireProductionAuth } from './production-auth.mjs';
import { observedReadiness } from '../modules/deploy-kit/readiness-window.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { contained } from './project.mjs';
import { invalid, refuse, RerError } from './errors.mjs';
import { ownerDeploy } from './deploy.mjs';
import { deployEnvironment, deployAgain } from './deploy-inputs.mjs';
import { claimHostedOwner } from './deploy-owner.mjs';
import { checkHostedSetup, hostedSetupFailure } from './deploy-setup.mjs';
import { mutationReadinessFailure } from './deploy-readiness.mjs';
import { observeOwner } from './deploy-observation.mjs';
import { committedSource } from './deploy-source.mjs';
import { hookOrigin, waitForSource } from './deploy-hook.mjs';
import { rememberHookState, hookState } from './deploy-hook-record.mjs';
import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { localOnlyBinding, ownerWorkerName } from '../modules/deploy-kit/owner.mjs';
import { refuseLocalModels } from '../modules/deploy-kit/local-only.mjs';
import { providerRefusal, providerTransport } from '../modules/deploy-kit/diagnostics.mjs';
import { shared } from './shared.mjs';

export function validateDeployOptions(options) {
 const changes = [options.remove && '--remove', options.setSecret && '--set-secret', options.unsetSecret && '--unset-secret'].filter(Boolean);
 if (changes.length > 1 || changes.length && options.dryRun) throw invalid(`Use ${changes.join(', ')}${options.dryRun ? ' and --dry-run' : ''} on separate runs.`);
 if (options.remove && !options.yes) throw invalid(`${deployAgain(options)} --remove deletes this environment's Worker and every D1, R2, KV and queue rer created for it, with their data. Add --yes to confirm.`);
}

// An explicit adapter declaration wins. Older hooks use a conventional root
// declaration; discover it by its schema, never by seed identity or hook source.
export async function declarationFor(root, adapter) {
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
 try { ownerWorkerName(declaration.project, options.environment ?? 'production'); }
 catch (error) {
  const message = {
   'invalid-owner-environment': 'Invalid deployment environment: use at most 32 characters, starting with a lowercase letter, with lowercase letters or digits separated by single hyphens.',
   'invalid-owner-project': 'Invalid deployment project in the deploy declaration: use a lowercase project name, optionally preceded by its owner and a slash.',
   'owner-name-too-long': 'The project and environment produce a Worker name longer than 63 characters.',
  }[error.message];
  if (!message) throw error;
  const failure = invalid(`${message} Nothing was uploaded.`);
  store.report(failure.message);
  throw failure;
 }
 const local = localOnlyBinding(declaration, localOnlyKeys);
 if (local) throw refuse(`${path} names the local-only key ${local} as a deploy binding or secret. Remove it; local dev keys never reach a deployment.`);
 // Custom hooks historically ignored these flags. Only the ownership controller
 // may perform them; neither a build nor a custom upload runs here.
 if (options.remove || options.setSecret || options.unsetSecret) return ownerDeploy(path, adapter)(context);
 if (adapter.deploy.managesHostedOwner) return adapter.deploy(context);
 const production = await deployEnvironment({ root, options, declaration, setupManifest, settings: adapter.settings, localOnlyKeys });
 await requireProductionAuth({ root, declaration, env: production.env, setupManifest, setupSeed: context.setupSeed, adapter, declarationPath: path, options });
 const sourceSha = options.dryRun ? undefined : committedSource(root, options);
 const { env, supplied } = await deployEnvironment({ root, options, declaration, setupManifest, settings: adapter.settings, localOnlyKeys });
 const { createRedaction, credentialValues } = await shared('redaction.mjs');
 const redaction = createRedaction();
 const addSecret = value => { redaction.addSecrets([value]); store.addSecrets?.([value]); };
 for (const value of [...credentialValues(env), env.CLOUDFLARE_ACCOUNT_ID, ...(declaration.secrets ?? []).map(item => env[item.environment])].filter(Boolean)) addSecret(value);
 const environment = options.environment ?? 'production';
 // A hook keeping the kit's record in its own state file named it; every kit
 // step after the hook (inspect, secret, record-owner) reads that record.
 let hookRecord = await hookState(root, environment);
 const command = (verb, extra = [], values = env, more = {}) => owner([verb, '--declaration', path, '--environment', environment, ...(hookRecord ? ['--state', hookRecord] : []), ...extra], values, { cwd: root, localOnlyKeys, ...more });
 // A hook that deployed through the kit's standard record lets rer issue and
 // retire the setup token; a hook keeping an unnamed record of its own keeps its token.
 let recorded;
 const inspect = async (origin = deployed?.origin) => {
  try { return recorded = await command('inspect', [], env, {propagation:observedReadiness(origin)?.propagation}); }
  catch (error) { if (error.message !== 'missing-owner-receipt') throw error; }
 };
 let observedClaims = [];
 let deployed, claimed, linked = false, linkResult, step = 'custom deploy';
 const link = async (token, origin) => { if (!linked) { const state = await inspect(origin); linkResult = await linkDependencies?.(state?.origin ?? origin, token); linked = true; } return linkResult; };
 try {
  return await observeOwner({ paths: ['/auth/bootstrap', adapter.hooks?.owner?.path, setupManifest?.steps?.find(item => item.type === 'owner-claim')?.path].filter(Boolean), inspect, beforeClaim: link, addSecret, deployed: () => deployed, tokenKey: setupManifest?.steps?.find(item => item.type === 'owner-claim')?.tokenField }, async claims => {
   observedClaims = claims;
   const saved = { ...process.env };
   try {
    Object.assign(process.env, env);
    deployed = await adapter.deploy({ ...context, linkDependencies: async (origin, token) => link(token, origin) });
   } finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    Object.assign(process.env, saved);
   }
   if (options.dryRun) return deployed;
   await rememberHookState(root, environment, deployed?.state);
   hookRecord = await hookState(root, environment);
   const origin = hookOrigin(deployed, deployAgain(options));
   const uploaded = observedReadiness(origin);
   step = 'wait for the deployed source';
   await waitForSource({ origin, sourceSha, uploaded, again: deployAgain(options) });
   step = 'verify recorded deployment';
   const state = await inspect();
   if ((state?.origin ?? origin) !== origin || claims.some(item => item.origin !== origin)) throw new Error('owner-claim-origin-mismatch');
   if (claims.some(item => !item.outcome)) throw new Error('owner-claim-failed');
   claimed = claims.at(-1)?.outcome;
   step = 'claim owner';
   if (typeof deployed.setupToken === 'string' && deployed.setupToken) addSecret(deployed.setupToken);
   const sentSecrets = (uploaded?.sentSecrets ?? []).filter(binding => uploaded.propagation.matchesToken(binding, env[declaration.secrets.find(item => item.binding === binding)?.environment]));
   const kit = state ? { secret: (extra, values) => command('secret', extra, values), recordClaim: outcome => command('record-owner', ['--outcome', outcome]) } : { token: deployed.setupToken || undefined };
   claimed = await claimHostedOwner({ hook: adapter.hooks?.owner, setupManifest, declaration, deployed: { ...state, sentSecrets, propagation:deployed.propagation ?? uploaded?.propagation, origin, owner: claimed, observedOwner: () => claims.at(-1)?.outcome }, env, supplied, ...kit, addSecret, beforeClaim: token => link(token, origin), store, signal: context.signal });
   if (!linked) await linkDependencies?.(origin);
   step = 'verify hosted setup';
   await checkHostedSetup({ origin, claimed: claimed ?? state?.ownerClaim?.outcome ?? claims.at(-1)?.outcome, signal: context.signal });
   if (claimed) store.report(`${claimed === 'claimed' ? 'Claimed the hosted owner' : 'The hosted owner was already claimed and was kept'}${state ? '; the one-time setup token was removed' : ''}. Sign in by email at ${origin}.`);
   const { setupToken: _, ...result } = deployed;
   return { ...result, ...(claimed ? { owner: claimed } : {}), dependenciesLinked: true };
  });
 } catch (error) {
  const again = deployAgain(options);
  const { commandFailure } = await shared('failures.mjs');
  if (error.hookFailure) throw commandFailure(store.redact?.(redaction.redact(error.message)) ?? redaction.redact(error.message));
  if (error instanceof RerError && !deployed?.deployed && !recorded) { error.message = store.redact?.(redaction.redact(error.message)) ?? redaction.redact(error.message); throw error; }
  const outcome = error.owner ?? claimed ?? observedClaims.at(-1)?.outcome;
  const state = deployed?.deployed || recorded ? `The application is deployed at ${deployed?.origin ?? recorded.origin}; ${outcome ? `owner ${outcome}` : 'owner claim is not confirmed'}${recorded ? '; setup token retirement is not confirmed' : ''}.` : 'The custom deploy did not finish; inspect its deployment record before recovery.';
  const redact = value => store.redact?.(redaction.redact(value)) ?? redaction.redact(value);
  const setup = hostedSetupFailure(error, { origin: deployed?.origin ?? recorded?.origin, again });
  if (setup) throw commandFailure(redact(setup));
  const readiness = mutationReadinessFailure(error, { again, redact });
  if (readiness) throw commandFailure(readiness);
  const refused = providerRefusal(error) ?? providerTransport(error);
  throw commandFailure(redact(`${state} Failed at ${step}: ${error.message}${refused ? ` (${refused})` : ''}${error.cause ? ` (${error.cause})` : ''}. Fix the cause and run ${again} again using the same environment credentials. ${outcome && recorded ? `To retire the token without rebuilding: ${again} --unset-secret ${setupManifest?.steps?.find(item => item.type === 'owner-claim')?.tokenField ?? 'SETUP_TOKEN'}.` : ''}`));
 }
}
