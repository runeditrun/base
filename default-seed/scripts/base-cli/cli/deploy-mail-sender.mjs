import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { publicOrigin } from '../modules/deploy-kit/public-origin.mjs';
import { hookState } from './deploy-hook-record.mjs';
import { cloudflareCredentials } from './deploy-needs.mjs';
import { loadState, deviceCredentialHandle } from './business/state.mjs';
import { createCredentialStore } from './business/keychain.mjs';
import { Api, ApiError } from './business/api.mjs';
import { mcpClient } from './business/questions.mjs';
import { toolRefusal } from './business/refusal.mjs';
import { businessCommand } from './business/invocation.mjs';

// Day-one mail for a deploy on the person's own Cloudflare: a seed that can send through Run Edit Run's relay (it
// declares MAIL_PROVIDER, MAIL_FROM, MAIL_RELAY_URL and MAIL_API_KEY as deploy secrets), deployed from a computer
// connected to a Business, gets the sender a Business tool gets from the door's mail.sender. The relay mails only the
// Business owner's verified address. The key goes only into this run's environment and so to the Worker's secret.
const RELAY = ['MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_RELAY_URL', 'MAIL_API_KEY'];
// Any of these supplied means the person chose their own mail, and rer leaves it to them.
const CHOSEN = [...RELAY, 'SENDGRID_API_KEY', 'RESEND_API_KEY', 'MAIL_PROVIDER_API_KEY', 'MAIL_ACCOUNT_ID'];
const present = value => typeof value === 'string' && Boolean(value.trim());

// The relay's four settings as the declaration lists them; a missing one is undefined. Only a declaration with all
// four gets the deploy's own MAIL_PROVIDER=none when no sender could be had.
export const relayDeclarations = declaration => RELAY.map(binding => (Array.isArray(declaration.secrets) ? declaration.secrets : []).find(item => item?.binding === binding));

/** Returns undefined when this is not rer's to decide (including a Worker that already holds mail: the sign-in preflight
 * counts it through the same live secret names), `{values, replace}` for a fresh sender (values by environment name;
 * `replace` names the relay settings the Worker already holds, such as MAIL_PROVIDER=none from a deploy with mail off,
 * which the upload would keep), or `{off: reason}` when no sender could be had. */
export async function deployMailSender({ root, declaration, declarationPath, env, options, name, ownerEmail, localOnlyKeys, report, addSecret }) {
 const secrets = Array.isArray(declaration.secrets) ? declaration.secrets : [];
 const relay = relayDeclarations(declaration);
 if (options.dryRun || relay.some(item => !item)) return;
 if (secrets.some(item => CHOSEN.includes(item?.binding) && present(env[item.environment])) || CHOSEN.some(key => present(env[key]))) return;
 // Without Cloudflare access nothing is deployed: the deploy's own checks name what is missing.
 if (cloudflareCredentials.some(key => !present(env[key]))) return;
 const environment = options.environment ?? 'production', state = await hookState(root, environment);
 const { origin, liveSecrets } = await owner(['address', '--declaration', declarationPath, '--environment', environment, ...(state ? ['--state', state] : [])], env, { cwd: root, localOnlyKeys });
 // Mail the person set up, or a sender an earlier deploy put on this Worker, stays: asking again would replace its key.
 if (liveSecrets.includes('MAIL_API_KEY')) return;
 const business = await loadState();
 if (!business?.origin || !business.businessId || !business.executorId) return { off: `this computer is not connected to a Business. Connect it with ${businessCommand('connect --business ID')} and deploy again` };
 if (business.revoked) return { off: `this computer's Business pairing was revoked` };
 const credential = await createCredentialStore().get(deviceCredentialHandle(business));
 if (!credential) return { off: `this computer's Business credential is missing` };
 const address = publicOrigin(declaration, env) ?? origin;
 if (!address) return { off: 'this deploy has no https address yet; set its public origin and deploy again' };
 const tool = (environment === 'production' ? name : `${name} (${environment})`).slice(0, 80);
 let answer;
 try {
  const door = await mcpClient(new Api(business.origin, credential), business, { signal: AbortSignal.timeout(55_000) });
  const handover = await door.call('read_handover');
  const verified = handover?.structuredContent?.owner_email;
  if (handover?.isError || typeof verified !== 'string') return { off: refused(handover, 'the Business owner has no verified email address') };
  if (present(ownerEmail) && ownerEmail.trim().toLowerCase() !== verified.trim().toLowerCase()) return { off: `this app's owner email is not the Business owner's verified address, the only one Run Edit Run's relay mails` };
  answer = await door.call('mail.sender', { tool, address });
 } catch (error) {
  // The Business answered no (pairing revoked, refused): there is no sender. A Business it could not reach stops the deploy.
  if (error instanceof ApiError) return { off: error.message };
  throw error;
 }
 const sender = answer?.structuredContent;
 if (answer?.isError || sender?.settings?.MAIL_PROVIDER !== 'rer' || !present(sender.secret?.MAIL_API_KEY)) return { off: refused(answer, 'the Business gave no sender') };
 const given = { ...sender.settings, MAIL_API_KEY: sender.secret.MAIL_API_KEY };
 addSecret(given.MAIL_API_KEY);
 report(`Mail: ${tool} sends through Run Edit Run's relay, to the Business owner's verified address only. Its key goes to this Worker's MAIL_API_KEY secret and nowhere else.`);
 return { values: Object.fromEntries(relay.map(item => [item.environment, given[item.binding]])), replace: RELAY.filter(binding => liveSecrets.includes(binding)) };
}

const refused = (result, otherwise) => toolRefusal(result).message ?? otherwise;
