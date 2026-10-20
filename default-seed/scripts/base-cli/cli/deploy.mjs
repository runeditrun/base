import { requireProductionAuth } from './production-auth.mjs';
import { readFile } from 'node:fs/promises';
import { deployDiagnostic, migrationFailure, providerFailure, assetFailure } from '../modules/deploy-kit/diagnostics.mjs';
import { shared } from './shared.mjs';
import { settingKinds } from './deploy-settings.mjs';
import { contained } from './project.mjs';
import { missing, invalid, refuse, RerError } from './errors.mjs';
import { localOnlyBinding } from '../modules/deploy-kit/owner.mjs';
import { secretFailureMessage } from './deploy-secret-error.mjs';
import { refuseLocalModels } from '../modules/deploy-kit/local-only.mjs';
import { deployEnvironment, deployAgain } from './deploy-inputs.mjs';
import { claimHostedOwner } from './deploy-owner.mjs';
import { deployOwnerInput } from './deploy-owner-input.mjs';
import { checkHostedSetup, hostedSetupFailure } from './deploy-setup.mjs';
import { mutationReadinessFailure } from './deploy-readiness.mjs';
import { committedSource } from './deploy-source.mjs';
import { hookState, forgetHookState } from './deploy-hook-record.mjs';
import { deploymentRecord } from './deployment-record.mjs';
import { cloudflareCredentials, missingCredentialsMessage } from './deploy-needs.mjs';
import { keptSecrets, keepSecrets, forgetSecrets } from './deploy-secrets.mjs';
import { withoutLocalSettings, refuseLocalEnvOutput } from './local-env.mjs';
import { deployProductDirectory, deployProductArguments } from './deploy-product.mjs';
import { rotateInstallationKey, reopenInstallationKey, keepInstallationKey } from './deploy-installation-key.mjs';

export function ownerDeploy(declarationPath, lifecycle) {
 // rer verify serves the build with this declaration's vars and secrets.
 return Object.assign(async ({ root, options, store, signal, operationToken, localOnlyKeys = [], checkBuild = async () => {}, setupManifest, setupSeed, linkDependencies, adapter = lifecycle }) => {
  try { await refuseLocalModels(root); } catch { throw refuse('Deploy refuses the local-only key file .rer/local/models.json. Remove live-dev credentials before deployment.'); }
  const path = await contained(root, declarationPath);
  let declaration; try { declaration = JSON.parse(await readFile(path, 'utf8')); } catch { throw invalid('Malformed owner-account deploy declaration.'); }
  const local = localOnlyBinding(declaration, localOnlyKeys);
  if (local) throw refuse(`${declarationPath} names the local-only key ${local} as a deploy binding or secret. Remove it; local dev keys never reach a deployment.`);
  const environment = options.environment ?? 'production';
  const again = deployAgain(options);
  const change = [options.remove && '--remove', options.setSecret && '--set-secret', options.unsetSecret && '--unset-secret', options.rotateSecret && '--rotate-secret', options.reopenInstallationKey && '--reopen-installation-key'].filter(Boolean);
  // The command that finishes what this run started: the same verb, never a plain deploy in its place.
  const retry = options.remove ? `${again} --remove --yes` : options.setSecret ? `${again} --set-secret ${options.setSecret}` : options.unsetSecret ? `${again} --unset-secret ${options.unsetSecret}` : options.rotateSecret ? `${again} --rotate-secret ${options.rotateSecret}` : options.reopenInstallationKey ? `${again} --reopen-installation-key ${options.reopenInstallationKey}` : again;
  if (change.length > 1 || change.length && options.dryRun) throw invalid(`Use ${change.join(', ')}${options.dryRun ? ' and --dry-run' : ''} on separate runs.`);
  if (options.remove && !options.yes) throw invalid(`${again} --remove deletes this environment's Worker and every D1, R2, KV and queue rer created for it, with their data. Add --yes to confirm.`);
  const productDirectory = change.length ? undefined : deployProductDirectory(declaration);
  const recordedState = change.length ? await deploymentRecord(root, options) : undefined;
  // A dry run reads the settings file too, so a refused key fails here and not only on the real deploy.
  if (options.dryRun && options.envFile) await deployEnvironment({ root, options, declaration, localOnlyKeys });
  let production, ownerInput, signIn;
  if (!change.length) {
   production = await deployEnvironment({ root, options, declaration, setupManifest, settings: lifecycle.settings, localOnlyKeys });
   ({signIn} = await requireProductionAuth({ root, declaration, env: production.env, setupManifest, setupSeed, adapter: lifecycle, declarationPath, options }) ?? {});
   if (!options.dryRun) committedSource(root, options);
   ownerInput = await deployOwnerInput({ root, adapter, setupSeed, options, signal });
   await withoutLocalSettings(root, { settings: lifecycle.settings, operationToken }, () => lifecycle.run(root, {}, store, () => {}, signal, { verb: 'build', operationToken }));
   await checkBuild();
   await refuseLocalEnvOutput(root);
  }
  const { env, supplied, generated, reused, rotated } = await deployEnvironment({ root, options, declaration, setupManifest, settings: lifecycle.settings, localOnlyKeys });
  if (options.setSecret || options.unsetSecret) secretChangeInputs(declaration, options, env, again);
  const kept = keptSecrets(declaration, setupManifest);
  if (cloudflareCredentials.some(name => !env[name]?.trim())) throw missing(missingCredentialsMessage(declaration, env, {dryRun:options.dryRun,signIn}));
  const { main } = await import('../modules/deploy-kit/owner-cli.mjs');
  const { createRedaction } = await shared('redaction.mjs');
  const redaction = createRedaction();
  redaction.addSecrets([...(await settingKinds({ declaration, setupManifest })).privateValues(env), env.CLOUDFLARE_ACCOUNT_ID, ...(declaration.secrets ?? []).map(item => env[item.environment]).filter(Boolean)]);
  const claim = setupManifest?.steps?.find(item => item.type === 'owner-claim');
  const declared = binding => (Array.isArray(declaration.secrets) ? declaration.secrets : []).find(item => item?.binding === binding);
  const owner = async (command, extra = [], values = env, more = {}) => main([command, '--declaration', declarationPath, '--environment', environment, ...(['dry-run', 'deploy', 'health'].includes(command) ? await deployProductArguments(root, productDirectory) : []), ...extra], values, { cwd: root, localOnlyKeys, ...more });
  // Keep confirmed creation events across deploy and the independent health call.
  const created = [];
  let step = 'deploy', deployed;
  try {
   if (options.dryRun) {
    const {optionalUnset} = await owner('dry-run');
    if (optionalUnset.length) store.report(`deploy: optional secrets not supplied: ${optionalUnset.join(', ')}. A Worker that does not hold one deploys without it.`);
    store.report('deploy: dry run complete; target secret bindings checked; no deployment occurred.');
    return { dryRun: true, deployed: false };
   }
   // A custom hook's own state file, when its deploy named one.
   const state = change.length ? recordedState : await hookState(root, environment);
   if (options.remove) {
    step = 'remove';
    const result = await owner('remove', state ? ['--state', state] : []);
    await forgetHookState(root, environment);
    await forgetSecrets(root, environment);
    store.report(`Removed ${result.removed.join(', ') || 'nothing (already gone)'}; read back: none of them remains.`);
    return { removed: result.removed, deployed: false };
   }
   if (options.reopenInstallationKey) {
    step = 'secrets';
    await reopenInstallationKey({ root, environment, declaration, env, owner, state, kid: options.reopenInstallationKey, report: line => store.report(line), addSecrets: values => { redaction.addSecrets(values); store.addSecrets?.(values); } });
    return { reopened: options.reopenInstallationKey, deployed: false };
   }
   if (options.rotateSecret) {
    // The kit never replaces a secret its Worker holds: rotation is this explicit change, kept once it is live.
    step = 'secrets';
    for (const binding of rotated) {
     if (binding === 'INSTALLATION_KEY') {
      await rotateInstallationKey({ root, environment, declaration, env, owner, state, report: line => store.report(line), addSecrets: values => { redaction.addSecrets(values); store.addSecrets?.(values); } });
      continue;
     }
     await owner('secret', ['--set', binding, ...(state ? ['--state', state] : [])]);
     await keepSecrets({ root, environment, kept, env, generated: [binding], reused: [], report: () => {} });
     store.report(`Rotated ${binding} on this environment's Worker to a fresh value kept in .rer/deploy/${environment}.secrets.env, recorded its new version and verified hosted readiness.`);
    }
    return { rotated, deployed: false };
   }
   if (change.length) {
    step = 'secrets';
    const bindings = (options.setSecret ?? options.unsetSecret).split(','), flag = options.setSecret ? '--set' : '--unset';
    await owner('secret', [...bindings.flatMap(binding => [flag, binding]), ...(state ? ['--state', state] : [])]);
    store.report(`${options.setSecret ? 'Set' : 'Removed'} ${bindings.join(', ')} on this environment's Worker as one new version, recorded it and verified hosted readiness.`);
    return { bindings, present: Boolean(options.setSecret), deployed: false };
   }
   store.report(`Deploying the ${environment} environment to your Cloudflare account.`);
   await keepInstallationKey({ root, environment, declaration, env, generated });
   deployed = await owner('deploy', [], env, { notice: line => store.report(line), onCreated: resource => created.push(redaction.redact(resource)) });
   // A generated value the kit did not send stays unknown: the Worker kept its own.
   const sent = supplied.filter(name => deployed.sentSecrets.includes(name)), keptSent = [...generated, ...reused].filter(name => sent.includes(name));
   await keepSecrets({ root, environment, kept, env, generated: generated.filter(name => sent.includes(name)), reused: reused.filter(name => sent.includes(name)), report: line => store.report(line) });
   const other = sent.filter(name => !keptSent.includes(name));
   if (other.length) store.report(`rer supplied ${other.join(', ')} from the local setup owner and fresh generated values.`);
   if (deployed.optionalUnset) store.report(`Optional secrets not set: ${deployed.optionalUnset.join(', ')}. The application runs without them; set one later with ${again} --set-secret NAME.`);
   step = 'health';
   await owner('health', [], env, {propagation:deployed.propagation});
   step = 'claim owner';
   const { liveSecrets, retiredSecrets, ownerClaim } = await owner('inspect', [], env, {propagation:deployed.propagation});
   const linked = token => linkDependencies?.(deployed.origin, token);
   const claimed = await claimHostedOwner({ hook: lifecycle.hooks?.owner, setupManifest, declaration, deployed: { ...deployed, propagation:deployed.propagation, liveSecrets, retiredSecrets, ownerClaim }, env, ...ownerInput, supplied, addSecret: value => { redaction.addSecrets([value]); store.addSecrets?.([value]); },
    secret: (extra, values) => owner('secret', extra, values), beforeClaim: linked, recordClaim: outcome => owner('record-owner', ['--outcome', outcome]), inspect: () => owner('inspect', [], env, {propagation:deployed.propagation}), store, signal });
   // A seed that claims its owner its own way links with the token it was given.
   if (claimed === undefined) await linked(env[declared(claim?.tokenField ?? 'SETUP_TOKEN')?.environment]);
   step = 'verify hosted setup';
   await checkHostedSetup({ origin: deployed.origin, claimed: claimed ?? ownerClaim?.outcome, signal });
   store.report(`Your application is live on your Cloudflare account at ${deployed.origin}.`);
   // The app claims the OWNER_EMAIL the Worker holds: the local one only when this run uploaded it.
   const email = declared(claim?.emailField);
   const named = !email ? '' : deployed.sentSecrets.includes(email.binding) && env[email.environment] ? ` (${env[email.environment]})` : ` (the ${email.binding} already set on the Worker)`;
   if (claimed) store.report(`${claimed === 'claimed' ? 'Claimed the hosted owner' : 'The hosted owner was already claimed and was kept'}${named}; the one-time setup token was removed. Sign in by email at ${deployed.origin}.`);
   return { deployed: true, origin: deployed.origin, ...(claimed ? { owner: claimed } : {}), dependenciesLinked: true };
  } catch (error) {
   if (error instanceof RerError) throw error;
   const { commandFailure } = await shared('failures.mjs');
   throw commandFailure(failureText({ error, step, created, again, retry, secretChange: Boolean(change.length && !options.remove), deployed, redact: redaction.redact }));
  }
 }, { declaration: declarationPath, managesHostedOwner: true });
}

// Every secret named in --set-secret or --unset-secret is declared, and each one set has its
// value, before any provider request: a group of secrets is changed whole or not at all.
function secretChangeInputs(declaration, options, env, again) {
 const declared = Array.isArray(declaration.secrets) ? declaration.secrets : [], flag = options.setSecret ? '--set-secret' : '--unset-secret';
 const named = (options.setSecret ?? options.unsetSecret).split(',');
 const undeclared = named.filter(name => !declared.some(item => item?.binding === name));
 if (undeclared.length) throw invalid(`${flag} names ${undeclared.join(', ')}, which the deploy declaration does not list as ${undeclared.length > 1 ? 'secrets' : 'a secret'}${declared.length ? ` (it declares ${declared.map(item => item.binding).join(', ')})` : ''}. Nothing was changed.`);
 if (!options.setSecret) return;
 const absent = named.map(name => declared.find(item => item.binding === name).environment).filter(name => !env[name]?.trim());
 if (absent.length) throw missing(`${flag} ${options.setSecret} needs a value for each secret; ${absent.join(', ')} ${absent.length > 1 ? 'are' : 'is'} not set. Set ${absent.length > 1 ? 'them' : 'it'} in the environment or in an --env-file file (owned, mode 0600, one line per secret), then run ${again} ${flag} ${options.setSecret} again. Nothing was changed.`);
}

// The failing step, its redacted cause, what this run created and the command that continues.
function failureText({ error, step, created, again, retry, secretChange, deployed, redact }) {
 if (step === 'remove') {
  const remaining = error.remaining;
  if (error.message === 'nothing-to-remove') return `There are no recorded resources to remove; nothing was removed.`;
  const cause = deployDiagnostic(error, redact)?.code ?? error.message;
  const count = Array.isArray(remaining) ? `${remaining.length} resources remain (${remaining.join(', ') || 'none'})` : 'the remaining resource count could not be read';
  const detail = providerFailure(error, redact);
  const failed = error.failed?.map(item => `${item.resource}: ${providerFailure(item.error, redact) ?? item.code}`).join('; ');
  return redact(`Removal failed: ${count}; run ${retry} again. Cause: ${cause}${detail ? ` (${detail})` : ''}${failed ? `; ${failed}` : ''}.`);
 }
 const setup = hostedSetupFailure(error, { origin: deployed?.origin, again });
 if (setup) return redact(setup);
 const readiness = mutationReadinessFailure(error, { again, redact });
 if (readiness) return readiness;
 const diagnostic = deployDiagnostic(error, redact);
 const code = diagnostic?.code ?? (/^[a-zA-Z0-9_-]{1,120}$/.test(error.message) ? redact(error.message) : 'deploy-failed');
 const at = step === 'deploy' ? diagnostic?.step ?? 'prepare deploy' : step;
 const secrets = secretFailureMessage(error);
 if (secrets) return secrets;
 if (code === 'nothing-to-remove') return `The deployment record selected by ${again} has no resources that rer owns, so --remove deletes nothing.`;
 if (code === 'owner-token-retirement-failed') return `The application is deployed at ${deployed?.origin}; owner ${error.owner}; setup token retirement failed (${redact(String(error.cause))}${providerFailure(error,redact) ? `; ${providerFailure(error,redact)}` : ''}). Run ${again} --unset-secret ${error.tokenKey ?? 'SETUP_TOKEN'} using the same environment credentials, or run ${again} again to finish.`;
 if (code === 'owner-claim-failed') return `The application is deployed at ${deployed?.origin}, but claiming its owner failed: ${redact(String(error.cause))}. Owner claim and setup token retirement are not confirmed; run ${again} again using the same environment credentials to finish.`;
 const resource = diagnostic?.resource ?? (error.resource ? redact(String(error.resource)) : undefined);
 if (code === 'resource-not-listed') return `Deploy stopped at ${at}: ${resource} was created, but Cloudflare's account listing still does not show it after two minutes. Nothing was uploaded.\nResources created this attempt: ${created.join(', ') || 'none'}.\nRun ${again} again once the listing catches up: it reuses ${resource}. To delete what this environment created instead: ${again} --remove --yes.`;
 const lines = [`Deploy failed at ${at}: ${code}${resource ? ` (${resource})` : ''}${diagnostic?.providerCodes?.length ? ` (provider ${diagnostic.providerCodes.join(', ')})` : ''}.`];
 const asset = assetFailure(error, redact);
 if (asset) lines.push(`${asset}.`);
 const transport = providerFailure(error, redact);
 if (transport) lines.push(`${transport}.`);
 if (diagnostic?.output && diagnostic.output !== '(no provider output)') lines.push(`First redacted output lines:\n${diagnostic.output}`);
 lines.push(`Resources created this attempt: ${created.join(', ') || 'none'}.`);
 const migration = migrationFailure(error, again);
 if (migration) lines.push(redact(migration));
 if (code !== 'uncertain-migration-claim' && !error.unconfirmedClaim) lines.push(recovery({ code, at, resource, again, retry, secretChange }));
 return lines.join('\n');
}

function recovery({ code, at, resource, again, retry, secretChange }) {
 const remove = `${again} --remove --yes`, removing = retry === remove;
 if (code === 'provider-incomplete-pagination') return `Cloudflare did not supply a complete list. Inspect the named GET call in Cloudflare, resolve its missing continuation, then run ${retry} again with the same account and environment. Keep the deployment record so rer can reuse its resources.`;
 if (code === 'owned-resource-replaced' || code === 'resource-name-collision') return `rer refuses to change a resource it did not create or that was replaced after it did; nothing was changed. Choose another --environment name, or remove the other resource yourself.`;
 // A lost create answer: the resource may exist, and rer cannot prove it made it.
 if (resource && (code === 'uncertain-resource-create' || code === 'provider-transport-failed' && at.startsWith('create '))) {
  if (resource.startsWith('worker:')) return `Possibly created: ${resource}. The answer to its first upload was lost and the live Worker does not match the build rer sent, so rer cannot prove it is its own. Deploy the same commit again to recover it, or inspect it in the Cloudflare dashboard: if it is the Worker from the interrupted run and its Durable Object data is disposable, delete it, then run ${retry} again.`;
  return `Possibly created: ${resource}. The provider's answer to its create was lost, so rer cannot prove it made it. Inspect it in the Cloudflare dashboard: if it exists and is the empty one from the interrupted run, delete it, then run ${retry} again.${removing || resource.startsWith('queues:') ? '' : ` Or run ${remove}: it deletes it once it confirms it is empty, together with everything else this environment created.`}`;
 }
 if (code === 'uncertain-resource-not-empty') return `Possibly created: ${resource}, but it holds data, so it may not be the one rer's interrupted run made and rer will not delete it. Inspect it in the Cloudflare dashboard; delete it yourself only if its data is disposable, then run ${retry} again.`;
 if (code === 'uncertain-resource-unverifiable') return `Possibly created: ${resource}. rer cannot read whether a queue holds messages, so it will not delete it. Inspect it in the Cloudflare dashboard: if it is the empty one from the interrupted run, delete it, then run ${retry} again.`;
 if (code === 'changed-or-uncertain-migration-history') return `${resource ?? 'A D1 database'} holds migration history this build does not match: a migration changed or missing since it was applied, or an unconfirmed one that is not this build's next migration; rer never guesses migration history. Inspect it in the Cloudflare dashboard: if it is the empty one from this interrupted first deploy, delete it with ${remove} (that deletes everything this environment created), then run ${again} again. If it holds data, resolve the interrupted migration by hand first (deploy-kit README, Migration safety).`;
 if (removing) return `Fix the cause, then run ${retry} again.`;
 if (secretChange) return `Fix the cause, then run ${retry} again; a plain ${again} does not make this change.`;
 return `Fix the cause, then run ${again} again: it continues with what was created. To delete what this environment created instead: ${remove}.`;
}
