import { NATIVE_MODELS, approve, canonical, exact, fail, reservation, validateRequest } from '../ai/native/policy.mjs';
import { privacySecret, refuseAiNames } from '../ai/native/names.mjs';
const listed = value => Array.isArray(value) ? value : [];
const bindingsOf = source => ['d1','r2','kv','queues','durableObjects','services'].flatMap(key => listed(source[key]).map(item => item?.binding));
/** The deploying account owner supplies this authority separately from seed source. */
export function ownerAi(target,declaration,env,bucketName,sourceSha) {
  // Seed variables, the origin variable and setting sources never use the reserved names; only derived values do.
  const native = declaration.ai && typeof declaration.ai === 'object' ? [declaration.ai.binding,declaration.ai.budgetBinding,declaration.ai.imageBinding] : [];
  refuseAiNames({ai:declaration.ai !== undefined,secrets:listed(declaration.secrets),names:[...Object.keys(declaration.vars ?? {}),declaration.originVar,declaration.publicOriginSetting,...bindingsOf(declaration),...native]});
  if (declaration.ai === undefined) return {};
  validateRequest(declaration.ai);
  if (typeof env.RER_AI_AUTHORITY !== 'string') fail('ai_hosting_unproven',503);
  let authority;
  try { authority = JSON.parse(env.RER_AI_AUTHORITY); } catch { fail('ai_policy_invalid',400); }
  const approved = approve(declaration.ai,authority);
  const accountId = target.accountId ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (authority.sourceSha !== sourceSha || authority.accountId !== accountId || authority.installation !== target.worker || authority.environment !== target.environment || !/^[a-f0-9]{32}$/.test(accountId ?? '')) fail('ai_policy_conflict');
  if (!declaration.durableObjects?.some(d => d.binding === approved.budgetBinding && d.className === 'AiAuthority' && d.storage === 'sqlite') || !declaration.r2?.some(d => d.binding === approved.imageBinding)) fail('ai_binding_missing');
  if (!listed(declaration.secrets).some(privacySecret)) fail('ai_privacy_unverified',503);
  // Qualification is supplied by installation authority, never inferred from an API example.
  for (const purpose of approved.purposes) { if (purpose.model !== NATIVE_MODELS[purpose.kind]) fail('ai_provider_unproven',503); reservation(approved,purpose); }
  const request = structuredClone(declaration.ai);
  return {ai:{request,authority},vars:{RER_AI_REQUEST:canonical(request),RER_AI_AUTHORITY:canonical(authority),RER_AI_ACCOUNT_ID:accountId,RER_AI_BUCKET_NAME:bucketName(approved.imageBinding)}};
}
/** A supplied plan passes the same reserved-name boundary as a planned declaration. */
export function validateAiPlan(plan) {
  refuseAiNames({ai:plan.ai !== undefined,vars:plan.vars ?? {},secrets:listed(plan.secrets),names:[...bindingsOf(plan),plan.ai?.request?.binding]});
  if (plan.ai === undefined) return;
  exact(plan.ai,['request','authority']);
  const approved = approve(plan.ai.request,plan.ai.authority);
  if (approved.installation !== plan.worker || !plan.durableObjects.some(d => d.binding === approved.budgetBinding && d.className === 'AiAuthority' && d.storage === 'sqlite') || !plan.r2.some(d => d.binding === approved.imageBinding) || !plan.secrets.some(privacySecret)) fail('ai_policy_conflict');
  const expected={RER_AI_REQUEST:canonical(plan.ai.request),RER_AI_AUTHORITY:canonical(plan.ai.authority)};
  for (const [k,v] of Object.entries(expected)) if (plan.vars[k] !== v) fail('ai_policy_conflict');
  if (plan.vars.RER_AI_ACCOUNT_ID !== approved.accountId || !/^[a-f0-9]{32}$/.test(plan.vars.RER_AI_ACCOUNT_ID ?? '') || plan.vars.RER_AI_BUCKET_NAME !== plan.r2.find(d => d.binding === approved.imageBinding).name) fail('ai_policy_conflict');
}
/** Bind the approval to this deployment before state settlement or provider effects. */
export function validateAiDeployment(plan,accountId,sourceSha) {
  if (plan.ai === undefined) return;
  if (plan.vars.RER_AI_ACCOUNT_ID !== accountId) throw Object.assign(new Error('ai-installation-account-mismatch'),{code:'ai-installation-account-mismatch'});
  if (plan.ai.authority.sourceSha !== sourceSha) throw Object.assign(new Error('ai-source-approval-mismatch'),{code:'ai-source-approval-mismatch'});
}
/** A built raw binding cannot silently bypass the owner declaration. */
export function validateBuiltAi(config,request) {
  const present = config.ai !== undefined && (typeof config.ai !== 'object' || config.ai === null || Object.keys(config.ai).length > 0);
  if (!present) { if (request !== undefined) fail('ai_binding_missing'); return; }
  if (request === undefined) fail('ai_binding_undeclared');
  validateRequest(request); exact(config.ai,['binding']);
  if (config.ai.binding !== request.binding) fail('ai_policy_conflict');
}
