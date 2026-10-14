import { readFile } from 'node:fs/promises';
import { deployDiagnostic } from '../modules/deploy-kit/diagnostics.mjs';
import { shared } from './shared.mjs';
import { contained } from './project.mjs';
import { missing, invalid, refuse, RerError } from './errors.mjs';
import { ownerPlan, ownerWorkerName, localOnlyBinding } from '../modules/deploy-kit/owner.mjs';
import { packageBuild } from '../modules/deploy-kit/prepare.mjs';
import { refuseLocalModels } from '../modules/deploy-kit/local-only.mjs';
import { deployEnvironment, deployAgain } from './deploy-inputs.mjs';
import { claimHostedOwner } from './deploy-owner.mjs';
import { mutationReadinessFailure } from './deploy-readiness.mjs';
import { committedSource } from './deploy-source.mjs';
import { hookState, forgetHookState } from './deploy-hook-record.mjs';

export function ownerDeploy(declarationPath, lifecycle) {
 // rer verify serves the build with this declaration's vars and secrets.
 return Object.assign(async ({ root, options, store, signal, operationToken, localOnlyKeys = [], checkBuild = async () => {}, setupManifest, linkDependencies }) => {
  try { await refuseLocalModels(root); } catch { throw refuse('Deploy refuses the local-only key file .rer/local/models.json. Remove live-dev credentials before deployment.'); }
  const path = await contained(root, declarationPath);
  let declaration; try { declaration = JSON.parse(await readFile(path, 'utf8')); } catch { throw invalid('Malformed owner-account deploy declaration.'); }
  const local = localOnlyBinding(declaration, localOnlyKeys);
  if (local) throw refuse(`${declarationPath} names the local-only key ${local} as a deploy binding or secret. Remove it; local dev keys never reach a deployment.`);
  const environment = options.environment ?? 'production';
  const again = deployAgain(options);
  const change = [options.remove && '--remove', options.setSecret && '--set-secret', options.unsetSecret && '--unset-secret'].filter(Boolean);
  // The command that finishes what this run started: the same verb, never a plain deploy in its place.
  const retry = options.remove ? `${again} --remove --yes` : options.setSecret ? `${again} --set-secret ${options.setSecret}` : options.unsetSecret ? `${again} --unset-secret ${options.unsetSecret}` : again;
  if (change.length > 1 || change.length && options.dryRun) throw invalid(`Use ${change.join(', ')}${options.dryRun ? ' and --dry-run' : ''} on separate runs.`);
  if (options.remove && !options.yes) throw invalid(`${again} --remove deletes this environment's Worker and every D1, R2, KV and queue rer created for it, with their data. Add --yes to confirm.`);
  // A dry run reads the settings file too, so a refused key fails here and not only on the real deploy.
  if (options.dryRun && options.envFile) await deployEnvironment({ root, options, declaration, localOnlyKeys });
  if (!change.length) {
   if (!options.dryRun) committedSource(root, options);
   await lifecycle.run(root, {}, store, () => {}, signal, { verb: 'build', operationToken });
   await checkBuild();
  }
  if (options.dryRun) {
   // Locally validate the real declaration/artifact without ownerTarget's
   // account lookup. This synthetic target is validation data, not a provider.
   const worker = ownerWorkerName(declaration.project, environment);
   const artifact = await packageBuild({ root, source: { sha: '0'.repeat(40), tree: '0'.repeat(40) }, runIdentity: { id: '0', attempt: '1' }, productDirectory: '' });
   ownerPlan({ project: declaration.project, environment, worker, origin: `https://${worker}.example.invalid` }, declaration, artifact, { localOnlyKeys });
   store.report('deploy: dry run complete; no deployment occurred and no provider request was made.');
   return { dryRun: true, deployed: false };
  }
  const { env, supplied } = await deployEnvironment({ root, options, declaration, setupManifest, settings: lifecycle.settings, localOnlyKeys });
  const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  if (names.some(name => !env[name]?.trim())) throw missing('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required. See the deploy-kit owner-account instructions.');
  const { main } = await import('../modules/deploy-kit/owner-cli.mjs');
  const { createRedaction, credentialValues } = await shared('redaction.mjs');
  const redaction = createRedaction();
  redaction.addSecrets([...credentialValues(env), env.CLOUDFLARE_ACCOUNT_ID, ...(declaration.secrets ?? []).map(item => env[item.environment]).filter(Boolean)]);
  const claim = setupManifest?.steps?.find(item => item.type === 'owner-claim');
  const declared = binding => (Array.isArray(declaration.secrets) ? declaration.secrets : []).find(item => item?.binding === binding);
  const owner = (command, extra = [], values = env, more = {}) => main([command, '--declaration', declarationPath, '--environment', environment, ...extra], values, { cwd: root, localOnlyKeys, ...more });
  // Keep confirmed creation events across deploy and the independent health call.
  const created = [];
  let step = 'deploy', deployed;
  try {
   // A custom hook's own state file, when its deploy named one.
   const state = await hookState(root, environment);
   if (options.remove) {
    step = 'remove';
    const result = await owner('remove', state ? ['--state', state] : []);
    await forgetHookState(root, environment);
    store.report(`Removed ${result.removed.join(', ') || 'nothing (already gone)'}; read back: none of them remains.`);
    return { removed: result.removed, deployed: false };
   }
   if (change.length) {
    step = 'secrets';
    const binding = options.setSecret ?? options.unsetSecret;
    await owner('secret', [options.setSecret ? '--set' : '--unset', binding, ...(state ? ['--state', state] : [])]);
    store.report(`${options.setSecret ? `Set ${binding}` : `Removed ${binding}`} on this environment's Worker, recorded its new version and verified hosted readiness.`);
    return { binding, present: Boolean(options.setSecret), deployed: false };
   }
   store.report(`Deploying the ${environment} environment to your Cloudflare account.`);
   deployed = await owner('deploy', [], env, { notice: line => store.report(line), onCreated: resource => created.push(redaction.redact(resource)) });
   const sent = supplied.filter(name => deployed.sentSecrets.includes(name));
   if (sent.length) store.report(`rer supplied ${sent.join(', ')} from the local setup owner and fresh generated values.`);
   step = 'health';
   await owner('health');
   store.report(`Your application is live on your Cloudflare account at ${deployed.origin}.`);
   step = 'claim owner';
   const { liveSecrets, retiredSecrets, ownerClaim } = await owner('inspect');
   const linked = token => linkDependencies?.(deployed.origin, token);
   const claimed = await claimHostedOwner({ hook: lifecycle.hooks?.owner, setupManifest, declaration, deployed: { ...deployed, liveSecrets, retiredSecrets, ownerClaim }, env, supplied, addSecret: value => { redaction.addSecrets([value]); store.addSecrets?.([value]); },
    secret: (extra, values) => owner('secret', extra, values), beforeClaim: linked, recordClaim: outcome => owner('record-owner', ['--outcome', outcome]), inspect: () => owner('inspect'), store, signal });
   // A seed that claims its owner its own way links with the token it was given.
   if (claimed === undefined) await linked(env[declared(claim?.tokenField ?? 'SETUP_TOKEN')?.environment]);
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

// The failing step, its redacted cause, what this run created and the command that continues.
function failureText({ error, step, created, again, retry, secretChange, deployed, redact }) {
 const readiness = mutationReadinessFailure(error, { again, redact });
 if (readiness) return readiness;
 const diagnostic = deployDiagnostic(error, redact);
 const code = diagnostic?.code ?? (/^[a-zA-Z0-9_-]{1,120}$/.test(error.message) ? redact(error.message) : 'deploy-failed');
 const at = step === 'deploy' ? diagnostic?.step ?? 'prepare deploy' : step;
 const input = /^missing-secret-([A-Z][A-Z0-9_]*)$/.exec(code)?.[1];
 if (input) return `Deploy needs ${input}, which the deploy declaration lists as a secret and the Worker does not hold it. Set ${input} in the environment or in an --env-file file (an owned 0600 file of KEY=VALUE lines), then run the same command again. Nothing was uploaded.${created.length ? ` Resources created this attempt: ${created.join(', ')}.` : ''}`;
 if (code === 'remove-incomplete') return `Removal stopped with ${error.remaining.join(', ')} still present${error.failed.length ? ` (${error.failed.map(item => `${item.resource}: ${item.code}`).join('; ')})` : ''}. Removed: ${error.removed.join(', ') || 'nothing'}. An R2 bucket must be empty before it can be deleted. Run ${again} --remove --yes again to finish.`;
 if (code === 'nothing-to-remove') return `This checkout has no rer deployment record for this environment, so --remove deletes nothing. Run it from the checkout that deployed it.`;
 if (code === 'owner-token-retirement-failed') return `The application is deployed at ${deployed?.origin}; owner ${error.owner}; setup token retirement failed (${redact(String(error.cause))}). Run ${again} --unset-secret ${error.tokenKey ?? 'SETUP_TOKEN'} using the same environment credentials, or run ${again} again to finish.`;
 if (code === 'owner-claim-failed') return `The application is deployed at ${deployed?.origin}, but claiming its owner failed: ${redact(String(error.cause))}. Owner claim and setup token retirement are not confirmed; run ${again} again using the same environment credentials to finish.`;
 const resource = diagnostic?.resource ?? (error.resource ? redact(String(error.resource)) : undefined);
 if (code === 'resource-not-listed') return `Deploy stopped at ${at}: ${resource} was created, but Cloudflare's account listing still does not show it after two minutes. Nothing was uploaded.\nResources created this attempt: ${created.join(', ') || 'none'}.\nRun ${again} again once the listing catches up: it reuses ${resource}. To delete what this environment created instead: ${again} --remove --yes.`;
 const lines = [`Deploy failed at ${at}: ${code}${resource ? ` (${resource})` : ''}${diagnostic?.providerCodes?.length ? ` (provider ${diagnostic.providerCodes.join(', ')})` : ''}.`];
 if (diagnostic?.output && diagnostic.output !== '(no provider output)') lines.push(`First redacted output lines:\n${diagnostic.output}`);
 lines.push(`Resources created this attempt: ${created.join(', ') || 'none'}.`);
 lines.push(recovery({ code, at, resource, again, retry, secretChange }));
 return lines.join('\n');
}

function recovery({ code, at, resource, again, retry, secretChange }) {
 const remove = `${again} --remove --yes`, removing = retry === remove;
 if (code === 'owned-resource-replaced' || code === 'resource-name-collision') return `rer refuses to change a resource it did not create or that was replaced after it did; nothing was changed. Choose another --environment name, or remove the other resource yourself.`;
 // A lost create answer: the resource may exist, and rer cannot prove it made it.
 if (resource && (code === 'uncertain-resource-create' || code === 'provider-transport-failed' && at.startsWith('create '))) {
  if (resource.startsWith('worker:')) return `Possibly created: ${resource}. The answer to its first upload was lost and the live Worker does not match the build rer sent, so rer cannot prove it is its own. Deploy the same commit again to recover it, or inspect it in the Cloudflare dashboard: if it is the Worker from the interrupted run and its Durable Object data is disposable, delete it, then run ${retry} again.`;
  return `Possibly created: ${resource}. The provider's answer to its create was lost, so rer cannot prove it made it. Inspect it in the Cloudflare dashboard: if it exists and is the empty one from the interrupted run, delete it, then run ${retry} again.${removing || resource.startsWith('queues:') ? '' : ` Or run ${remove}: it deletes it once it confirms it is empty, together with everything else this environment created.`}`;
 }
 if (code === 'uncertain-resource-not-empty') return `Possibly created: ${resource}, but it holds data, so it may not be the one rer's interrupted run made and rer will not delete it. Inspect it in the Cloudflare dashboard; delete it yourself only if its data is disposable, then run ${retry} again.`;
 if (code === 'uncertain-resource-unverifiable') return `Possibly created: ${resource}. rer cannot read whether a queue holds messages, so it will not delete it. Inspect it in the Cloudflare dashboard: if it is the empty one from the interrupted run, delete it, then run ${retry} again.`;
 if (code === 'changed-or-uncertain-migration-history') return `${resource ?? 'A D1 database'} holds a migration rer started but could not confirm, or one changed since it was applied; rer never retries or guesses a migration. Inspect it in the Cloudflare dashboard: if it is the empty one from this interrupted first deploy, delete it with ${remove} (that deletes everything this environment created), then run ${again} again. If it holds data, resolve the interrupted migration by hand first (deploy-kit README, Migration safety).`;
 if (removing) return `Fix the cause, then run ${retry} again.`;
 if (secretChange) return `Fix the cause, then run ${retry} again; a plain ${again} does not make this change.`;
 return `Fix the cause, then run ${again} again: it continues with what was created. To delete what this environment created instead: ${remove}.`;
}
