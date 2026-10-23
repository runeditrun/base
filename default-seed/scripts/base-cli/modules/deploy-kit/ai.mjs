import { NATIVE_MODELS, approve, exact, fail, reservation, validateRequest } from '../ai/native/policy.mjs';
import { AI_PRIVACY_TOKEN, DENY, admit, runtimeNames } from '../ai/native/names.mjs';
const listed = value => Array.isArray(value) ? value : [];
// Declaration and plan entries that bind a runtime resource, service or Durable Object name.
const FAMILIES = {d1:'d1', r2:'r2_bucket', kv:'kv_namespace', queues:'queue', durableObjects:'durable_object_namespace', services:'service'};
const resources = source => Object.entries(FAMILIES).flatMap(([key, type]) => listed(source[key]).map(item => ({type, name:item?.binding})));
const secret = item => ({type:'secret_text', name:item?.binding, environment:item?.environment, optional:item?.optional === true});
const privacySecret = item => item?.binding === AI_PRIVACY_TOKEN && item.environment === AI_PRIVACY_TOKEN && !item.optional;
const mismatch = code => Object.assign(new Error(code), {code});

/** The deploying account owner supplies this authority separately from seed source. Every name
 * the declaration asks to bind passes the runtime-name projection: seed variables, the origin
 * variable and its setting source, resource, service and native AI bindings never use the
 * reserved namespace; a secret may be the private-token pair only under the approval. */
export function ownerAi(target,declaration,env,bucketName,sourceSha) {
  const native = declaration.ai && typeof declaration.ai === 'object' ? ['binding','budgetBinding','imageBinding'].map(key => ({type:'ai',name:declaration.ai[key]})) : [];
  const secrets = listed(declaration.secrets);
  // Nothing reserved without approval; a declaration asking for ai leaves its private-token pair to the approval below.
  admit(DENY,[...Object.keys(declaration.vars ?? {}).map(name => ({type:'var',name})),{type:'var',name:declaration.originVar,environment:declaration.publicOriginSetting},...resources(declaration),...native,
    ...secrets.filter(item => declaration.ai === undefined || !privacySecret(item)).map(secret)]);
  if (declaration.ai === undefined) return {};
  validateRequest(declaration.ai);
  if (typeof env.RER_AI_AUTHORITY !== 'string') fail('ai_hosting_unproven',503);
  let authority;
  try { authority = JSON.parse(env.RER_AI_AUTHORITY); } catch { fail('ai_policy_invalid',400); }
  const approved = approve(declaration.ai,authority);
  const accountId = target.accountId ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (authority.sourceSha !== sourceSha || authority.accountId !== accountId || authority.installation !== target.worker || authority.environment !== target.environment || !/^[a-f0-9]{32}$/.test(accountId ?? '')) fail('ai_policy_conflict');
  if (!declaration.durableObjects?.some(d => d.binding === approved.budgetBinding && d.className === 'AiAuthority' && d.storage === 'sqlite') || !declaration.r2?.some(d => d.binding === approved.imageBinding)) fail('ai_binding_missing');
  if (!secrets.some(privacySecret)) fail('ai_privacy_unverified',503);
  // Qualification is supplied by installation authority, never inferred from an API example.
  for (const purpose of approved.purposes) { if (purpose.model !== NATIVE_MODELS[purpose.kind]) fail('ai_provider_unproven',503); reservation(approved,purpose); }
  const request = structuredClone(declaration.ai);
  const names = runtimeNames({request,authority,accountId,bucket:bucketName(approved.imageBinding)});
  admit(names,secrets.map(secret));
  // The policy variables are the projection's own derived values, never seed input.
  return {ai:{request,authority},vars:{...names.allow}};
}
/** A plan's runtime names: the projection a Workers plan is rendered, uploaded and read back
 * through, so a supplied plan passes the same boundary as a planned declaration. An approved
 * plan is complete and consistent; given `pairing`, its approval must also be this account's
 * (`accountId`) and the source it deploys or reads (`sourceSha`). */
export function planNames(plan,pairing) {
  let names = DENY;
  if (plan.ai !== undefined) {
    exact(plan.ai,['request','authority']);
    const approved = approve(plan.ai.request,plan.ai.authority);
    const images = listed(plan.r2).find(d => d.binding === approved.imageBinding);
    if (approved.installation !== plan.worker || !listed(plan.durableObjects).some(d => d.binding === approved.budgetBinding && d.className === 'AiAuthority' && d.storage === 'sqlite') || !images || !listed(plan.secrets).some(privacySecret)) fail('ai_policy_conflict');
    if (pairing && plan.vars?.RER_AI_ACCOUNT_ID !== pairing.accountId) throw mismatch('ai-installation-account-mismatch');
    if (pairing && plan.ai.authority.sourceSha !== pairing.sourceSha) throw mismatch('ai-source-approval-mismatch');
    names = runtimeNames({...plan.ai,accountId:approved.accountId,bucket:images.name});
    for (const [name,text] of Object.entries(names.allow)) if (plan.vars?.[name] !== text) fail('ai_policy_conflict');
  }
  admit(names,[...Object.entries(plan.vars ?? {}).map(([name,text]) => ({type:'plain_text',name,text})),...listed(plan.secrets).map(secret),...resources(plan),...(plan.ai ? [{type:'ai',name:plan.ai.request.binding}] : [])]);
  return names;
}
/** The runtime names of a recorded deployment: its approval re-derived from the receipt's own
 * configuration, still this account's (the receipt's, the target's and the approval's payer are one
 * account) and installation's, and paired with the source it deployed. */
export function recordedNames(receipt,target) {
  if (receipt?.config?.ai === undefined) return DENY;
  const vars = receipt.config.vars ?? {};
  let request, authority;
  try { request = JSON.parse(vars.RER_AI_REQUEST); authority = JSON.parse(vars.RER_AI_AUTHORITY); } catch { fail('ai_policy_conflict'); }
  const names = runtimeNames({request,authority,accountId:vars.RER_AI_ACCOUNT_ID,bucket:vars.RER_AI_BUCKET_NAME});
  if (receipt.accountId !== target.accountId || authority.accountId !== receipt.accountId || authority.sourceSha !== receipt.source?.sha || authority.installation !== target.worker || authority.environment !== target.environment || receipt.config.ai.binding !== request.binding) fail('ai_policy_conflict');
  return names;
}
/** A built raw binding cannot silently bypass the owner declaration. */
export function validateBuiltAi(config,request) {
  const present = config.ai !== undefined && (typeof config.ai !== 'object' || config.ai === null || Object.keys(config.ai).length > 0);
  if (!present) { if (request !== undefined) fail('ai_binding_missing'); return; }
  if (request === undefined) fail('ai_binding_undeclared');
  validateRequest(request); exact(config.ai,['binding']);
  if (config.ai.binding !== request.binding) fail('ai_policy_conflict');
}
