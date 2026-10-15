import { declarationFor } from './deploy-command.mjs';
import { deployEnvironment, deployAgain } from './deploy-inputs.mjs';
import { hookState } from './deploy-hook-record.mjs';
import { missing, refuse, RerError } from './errors.mjs';
import { shared } from './shared.mjs';
import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { deployDiagnostic, providerRefusal } from '../modules/deploy-kit/diagnostics.mjs';

// rer signin: the owner's way into a hosted install without mail. With the same
// Cloudflare credentials that deployed it, rer writes a one-time grant (only its
// SHA-256) into the deployment's auth D1 and prints the link once to this terminal.
// It never reaches a log, receipt or the deploy record; the Worker admits it only
// for the recorded owner, once, within 15 minutes, and logs its use.
export async function signinCommand(project, options, out, { fetch } = {}) {
 if (project.profile !== 'first-party' || typeof project.adapter?.deploy !== 'function') throw refuse('rer signin needs a seed with an owner-account deploy declaration.');
 const root = project.root, environment = options.environment ?? 'production', again = deployAgain(options).replace(/^rer deploy/, 'rer signin');
 const { path, value: declaration } = await declarationFor(root, project.adapter);
 const { env } = await deployEnvironment({ root, options, declaration, localOnlyKeys: project.adapter.localOnlyKeys ?? [] });
 if (['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].some(name => !env[name]?.trim())) throw missing('rer signin uses the Cloudflare credentials that deployed this environment: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment or an --env-file, then run it again.');
 const { createRedaction, credentialValues } = await shared('redaction.mjs');
 const redaction = createRedaction();
 redaction.addSecrets([...credentialValues(env), env.CLOUDFLARE_ACCOUNT_ID]);
 const state = await hookState(root, environment);
 let result;
 try { result = await owner(['signin', '--declaration', path, '--environment', environment, ...(state ? ['--state', state] : [])], env, { cwd: root, localOnlyKeys: project.adapter.localOnlyKeys ?? [], ...(fetch ? { fetch } : {}) }); }
 catch (error) { throw failure(error, { environment, again, redact: redaction.redact }); }
 const minutes = Math.round((result.expiresAt - Date.now()) / 60000);
 if (!options.json) out.human(`One-time sign-in link for the owner ${result.email}. It works once, only for that owner, and expires in ${minutes} minutes. rer does not save it; open it now:\n${result.link}`);
 return { owner: result.email, expiresAt: result.expiresAt, ...(options.json ? { link: result.link } : {}) };
}

function failure(error, { environment, again, redact }) {
 const code = deployDiagnostic(error, redact)?.code ?? error.message;
 if (code === 'missing-owner-receipt') return refuse(`This checkout has no completed rer deployment of the ${environment} environment. Run rer signin from the checkout that deployed it (rer deploy --environment ${environment}).`);
 if (code === 'owned-resource-replaced') return refuse(`The ${environment} Worker is no longer the one this checkout deployed, so rer will not sign anyone in to it. Run rer deploy --environment ${environment} first.`);
 if (code === 'owner-signin-unsupported') return refuse(`The ${environment} deployment's database has no owner sign-in table. Update the seed to a rer that includes operator-auth's accounts/schema/owner-signin.sql migration, run rer deploy --environment ${environment}, then ${again}.`);
 if (code === 'owner-signin-ambiguous') return refuse(`More than one D1 database of the ${environment} deployment holds an owner sign-in table, so rer cannot tell which one signs in the owner. Nothing was written.`);
 if (code === 'owner-not-claimed') return refuse(`No owner has claimed the ${environment} deployment yet. Run rer deploy --environment ${environment}: it claims the owner. Nothing was written.`);
 const refusal = providerRefusal(error, redact);
 return new RerError('command_failed', `rer signin failed: ${/^[a-zA-Z0-9_-]{1,120}$/.test(code) ? redact(code) : 'signin-failed'}${refusal ? ` (${refusal})` : ''}. No sign-in link was issued; run ${again} again.`, 1);
}
