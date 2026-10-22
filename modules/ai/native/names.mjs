/** Runtime names this module reads as installation authority: the policy variables,
 * the payer and bucket it checks, and the private token for bucket-privacy readback. */
export const AI_VARIABLES = Object.freeze(['RER_AI_REQUEST','RER_AI_AUTHORITY','RER_AI_ACCOUNT_ID','RER_AI_BUCKET_NAME']);
export const AI_PRIVACY_TOKEN = 'RER_AI_PRIVACY_TOKEN';
/** The whole namespace is reserved, including names no release reads yet. Case and prefix
 * lookalikes (rer_ai_authority, APP_RER_AI_AUTHORITY) are ordinary names. */
export const reservedAiName = name => typeof name === 'string' && name.startsWith('RER_AI_');
/** The approved private-token secret: bound and sourced under its own name, never optional. */
export const privacySecret = item => item?.binding === AI_PRIVACY_TOKEN && item.environment === AI_PRIVACY_TOKEN && !item.optional;

/** The one boundary for every channel that binds a runtime name: plain-text variables,
 * secrets and the environment names they are sourced from, resource, service and native
 * bindings, and secrets a live Worker already holds (inherited or kept by an upload).
 * `names` are never approved: seed variables, setting sources and bindings. Without
 * approved `ai` nothing may use the namespace. With it, only the derived policy variables
 * and the approved private-token secret may. Refusal is a typed `ai_policy_conflict`
 * naming the channel and name. */
export function refuseAiNames({ai = false, vars = {}, secrets = [], names = [], held = []}) {
  const refuse = resource => { throw Object.assign(new Error('ai_policy_conflict'), {code:'ai_policy_conflict', status:409, resource}); };
  for (const name of Object.keys(vars)) if (reservedAiName(name) && !(ai && AI_VARIABLES.includes(name))) refuse(`var:${name}`);
  for (const item of secrets) if ((reservedAiName(item?.binding) || reservedAiName(item?.environment)) && !(ai && privacySecret(item))) refuse(`secret:${item.binding}`);
  for (const name of names) if (reservedAiName(name)) refuse(`name:${name}`);
  for (const name of held) if (reservedAiName(name) && !(ai && name === AI_PRIVACY_TOKEN)) refuse(`secret:${name}`);
}
