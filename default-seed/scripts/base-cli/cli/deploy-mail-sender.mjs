import { main as owner } from '../modules/deploy-kit/owner-cli.mjs';
import { publicOrigin } from '../modules/deploy-kit/public-origin.mjs';
import { hookState } from './deploy-hook-record.mjs';
import { mailBusiness, rememberMailBusiness } from './deploy-mail-record.mjs';
import { cloudflareCredentials } from './deploy-needs.mjs';
import { loadState, deviceCredentialHandle } from './business/state.mjs';
import { createCredentialStore } from './business/keychain.mjs';
import { Api, ApiError } from './business/api.mjs';
import { mcpClient } from './business/questions.mjs';
import { toolRefusal } from './business/refusal.mjs';
import { businessCommand } from './business/invocation.mjs';
import { refuse } from './errors.mjs';

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

/** Returns undefined when this is not rer's to decide (including a Worker that already holds a working relay sender or
 * the person's own mail: the sign-in preflight counts it through the same live secret names), `{values, replace, tool,
 * settings}` for a fresh sender (values by environment name; `replace` names the relay settings the Worker already holds,
 * such as MAIL_PROVIDER=none from a deploy with mail off, which the upload would keep), or `{off: reason}` when no sender
 * could be had. `credentialNames` is a function returning the seed's declared mail credential secrets. */
export async function deployMailSender({ root, declaration, declarationPath, env, options, name, ownerEmail, localOnlyKeys, report, addSecret, credentialNames }) {
 const secrets = Array.isArray(declaration.secrets) ? declaration.secrets : [];
 const relay = relayDeclarations(declaration);
 if (options.dryRun || relay.some(item => !item)) return;
 if (secrets.some(item => CHOSEN.includes(item?.binding) && present(env[item.environment])) || CHOSEN.some(key => present(env[key]))) return;
 // Without Cloudflare access nothing is deployed: the deploy's own checks name what is missing.
 if (cloudflareCredentials.some(key => !present(env[key]))) return;
 const environment = options.environment ?? 'production', state = await hookState(root, environment);
 const { origin, liveSecrets } = await owner(['address', '--declaration', declarationPath, '--environment', environment, ...(state ? ['--state', state] : [])], env, { cwd: root, localOnlyKeys });
 // Mail the person set up in their own provider (held native credentials, declared or not) is theirs: rer leaves it.
 const own = [...CHOSEN, ...await credentialNames?.() ?? []].filter(key => !RELAY.includes(key));
 if (own.some(key => liveSecrets.includes(key))) return;
 const holdsKey = liveSecrets.includes('MAIL_API_KEY');
 if (holdsKey && !RELAY.every(binding => liveSecrets.includes(binding))) return;
 const business = await loadState();
 // A key another Business issued is not dead because this computer is connected to a different one now.
 if (holdsKey && business?.businessId) { const issuer = await mailBusiness(root, environment); if (issuer && issuer !== business.businessId) return; }
 const credential = business?.origin && business.businessId && business.executorId && !business.revoked ? await createCredentialStore().get(deviceCredentialHandle(business)) : undefined;
 // A Worker holding a sender stays as it is unless the Business says that sender is gone (below).
 if (holdsKey && !credential) return;
 if (!business?.origin || !business.businessId || !business.executorId) return { off: `this computer is not connected to a Business. Connect it with ${businessCommand('connect --business ID')} and deploy again` };
 if (business.revoked) return { off: `this computer's Business pairing was revoked` };
 if (!credential) return { off: `this computer's Business credential is missing` };
 const address = publicOrigin(declaration, env) ?? origin;
 if (!address) return holdsKey ? undefined : { off: 'this deploy has no https address yet; set its public origin and deploy again' };
 const tool = (environment === 'production' ? name : `${name} (${environment})`).slice(0, 80);
 let door, handover;
 try {
  door = await mcpClient(new Api(business.origin, credential), business, { signal: AbortSignal.timeout(55_000) });
  handover = await door.call('read_handover');
 } catch (error) {
  // A held sender is not put at risk by a Business that is out of reach: the deploy goes on with it.
  if (holdsKey) return;
  // The Business answered no (pairing revoked, refused): there is no sender. A Business it could not reach stops the deploy.
  if (error instanceof ApiError) return { off: error.message };
  throw refuse(`${error.message} Nothing was built or uploaded. Deploy again when it answers, or supply this seed's own mail settings.`);
 }
 const verified = handover?.structuredContent?.owner_email;
 // The platform keys a sender by tool alone and a new one replaces the old: never replace a live sender that belongs to another address.
 const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ');
 const live = Array.isArray(handover?.structuredContent?.mail_senders) ? handover.structuredContent.mail_senders.find(item => norm(item?.tool) === norm(tool)) : undefined;
 // The Worker's own sender may be at its workers.dev origin or at the public origin it moved to: the relay does not check the address.
 const mine = new Set([address, origin].filter(Boolean).map(value => new URL(value).origin));
 const elsewhere = live && !mine.has(live.address);
 if (holdsKey) {
  // The Worker's key works while the Business lists a live sender for this tool at this address. Otherwise it is dead
  // (the computer was disconnected or the sender revoked) and gets a new one, unless that would stop another Worker's.
  if (handover?.isError || !Array.isArray(handover?.structuredContent?.mail_senders) || live && !elsewhere) return;
  if (elsewhere) return { off: `this Worker's relay key is no longer live and ${tool} has a live sender for ${live.address}, which a new one would stop. Revoke it with ${businessCommand(`call mail.sender.revoke --tool "${tool}"`)} or deploy this copy under another --environment, then deploy again` };
 }
 if (handover?.isError || typeof verified !== 'string') return { off: refused(handover, 'the Business owner has no verified email address') };
 if (ownerEmail !== undefined && (!present(ownerEmail) || ownerEmail.trim().toLowerCase() !== verified.trim().toLowerCase())) return { off: `this app's owner email is not the Business owner's verified address, the only one Run Edit Run's relay mails. Set OWNER_EMAIL to that address and deploy again` };
 if (elsewhere) return { off: `${tool} already has a live sender for ${live.address}; a new one would stop that Worker's mail. Revoke it with ${businessCommand(`call mail.sender.revoke --tool "${tool}"`)} or deploy this copy under another --environment` };
 let answer;
 try { answer = await door.call('mail.sender', { tool, address }); }
 catch (error) {
  if (error instanceof ApiError) return { off: error.message };
  throw refuse(`${error.message} Nothing was built or uploaded. Deploy again when it answers, or supply this seed's own mail settings.`);
 }
 const sender = answer?.structuredContent;
 if (answer?.isError || sender?.settings?.MAIL_PROVIDER !== 'rer' || !present(sender.secret?.MAIL_API_KEY)) return { off: refused(answer, 'the Business gave no sender') };
 const given = { ...sender.settings, MAIL_API_KEY: sender.secret.MAIL_API_KEY };
 addSecret(given.MAIL_API_KEY);
 await rememberMailBusiness(root, environment, business.businessId);
 report(`Mail: ${tool} sends through Run Edit Run's relay, to the Business owner's verified address only. Its key goes to this Worker's MAIL_API_KEY secret and nowhere else.`);
 return { values: Object.fromEntries(relay.map(item => [item.environment, given[item.binding]])), replace: RELAY.filter(binding => liveSecrets.includes(binding)), tool, settings: sender.settings };
}

const refused = (result, otherwise) => toolRefusal(result).message ?? otherwise;
