import { AiError } from '../errors.mjs';
export const fail = (code, status = 409) => { throw new AiError(code, status); };
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('ai_policy_invalid', 400);
  return value;
}
export const integer = value => Number.isSafeInteger(value) && value >= 0;
export const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export function sum(...values) {
  if (!values.every(integer)) fail('ai_accounting_invalid');
  const result = values.reduce((a, b) => a + BigInt(b), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('ai_accounting_invalid');
  return Number(result);
}
export function estimate(units, rate) {
  if (!integer(units) || !integer(rate)) fail('ai_accounting_invalid');
  const cost = (BigInt(units) * BigInt(rate) + 999999n) / 1000000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) fail('ai_accounting_invalid');
  return Number(cost);
}
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
const binding = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const model = value => typeof value === 'string' && /^@cf\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(value);
const limits = ['calls','units','microUsd'];
export function validateRequest(value) {
  exact(value, ['schema','provider','transport','binding','budgetBinding','imageBinding','textModels','imageModels','purposes','limits','operations']);
  if (value.schema !== 1 || value.provider !== 'cloudflare' || value.transport !== 'native' || !binding(value.binding) || !binding(value.budgetBinding) || !binding(value.imageBinding) || new Set([value.binding,value.budgetBinding,value.imageBinding]).size !== 3) fail('ai_policy_invalid', 400);
  for (const key of ['textModels','imageModels']) if (!Array.isArray(value[key]) || value[key].length > 8 || new Set(value[key]).size !== value[key].length || !value[key].every(model)) fail('ai_policy_invalid', 400);
  if (!Array.isArray(value.purposes) || !value.purposes.length || value.purposes.length > 16 || new Set(value.purposes.map(p => p.id)).size !== value.purposes.length) fail('ai_policy_invalid', 400);
  for (const p of value.purposes) {
    exact(p, ['id','kind','model']);
    if (!name(p.id) || !['text','image'].includes(p.kind) || !value[p.kind === 'text' ? 'textModels' : 'imageModels'].includes(p.model)) fail('ai_policy_invalid', 400);
  }
  exact(value.limits, limits);
  if (!limits.every(k => integer(value.limits[k]))) fail('ai_policy_invalid', 400);
  exact(value.operations, ['textCalls','maxInputBytes','maxOutputTokens','imageUnits','timeoutMs']);
  const o = value.operations;
  if (o.textCalls !== 2 || ![o.maxInputBytes,o.maxOutputTokens,o.imageUnits,o.timeoutMs].every(integer) || o.maxInputBytes < 1 || o.maxInputBytes > 100000 || o.maxOutputTokens < 1 || o.maxOutputTokens > 8192 || o.timeoutMs < 1 || o.timeoutMs > 120000) fail('ai_policy_invalid', 400);
  return value;
}
/** This input is installation authority, never a seed declaration or browser body. */
export function approve(request, authority) {
  validateRequest(request);
  exact(authority, ['schema','enabled','installation','environment','tenant','revision','custody','permitted','prices','proofs']);
  if (authority.schema !== 1 || authority.enabled !== true) fail('ai_disabled', 503);
  if (![authority.installation,authority.environment,authority.tenant].every(name) || !name(authority.revision) || !name(authority.custody)) fail('ai_policy_invalid');
  validateRequest(authority.permitted);
  for (const key of ['provider','transport','binding','budgetBinding','imageBinding']) if (request[key] !== authority.permitted[key]) fail('ai_policy_conflict');
  const permitted = authority.permitted;
  const purposes = request.purposes.filter(p => permitted.purposes.some(q => canonical(p) === canonical(q)));
  const approved = structuredClone(request);
  approved.purposes = purposes;
  for (const key of ['textModels','imageModels']) approved[key] = request[key].filter(m => permitted[key].includes(m));
  approved.limits = Object.fromEntries(limits.map(k => [k, Math.min(request.limits[k], permitted.limits[k])]));
  for (const key of Object.keys(approved.operations)) approved.operations[key] = Math.min(request.operations[key], permitted.operations[key]);
  return { ...approved, installation:authority.installation,environment:authority.environment,tenant:authority.tenant,revision:authority.revision,custody:authority.custody,prices:authority.prices,proofs:authority.proofs };
}
export function priceFor(policy, purpose, now = Date.now()) {
  const price = policy.prices?.[purpose.model];
  exact(price, ['version','validUntil','inputMicroUsdPerMillion','outputMicroUsdPerMillion','imageMicroUsdPerUnit']);
  if (!name(price.version) || !integer(price.validUntil) || now >= price.validUntil || ![price.inputMicroUsdPerMillion,price.outputMicroUsdPerMillion,price.imageMicroUsdPerUnit].every(integer)) fail('ai_price_unavailable', 503);
  return price;
}
export function reservation(policy, purpose) {
  const o = policy.operations, price = priceFor(policy, purpose);
  // Input tokens use the adapter's proven hard ceiling, not an average tokenizer ratio.
  const proof = policy.proofs?.[purpose.model];
  exact(proof, ['reference','kind','maxInputTokens','maxOutputTokens','maxImageUnits','mime']);
  if (!name(proof.reference) || proof.kind !== purpose.kind || ![proof.maxInputTokens,proof.maxOutputTokens,proof.maxImageUnits].every(integer)) fail('ai_provider_unproven', 503);
  if (purpose.kind === 'text' && (proof.maxInputTokens < 262144 || proof.maxOutputTokens < o.maxOutputTokens)) fail('ai_provider_unproven', 503);
  if (purpose.kind === 'image' && (proof.maxImageUnits < 1 || proof.maxImageUnits > o.imageUnits || proof.mime !== 'image/png')) fail('ai_provider_unproven', 503);
  const units = purpose.kind === 'text' ? sum(proof.maxInputTokens, proof.maxOutputTokens) : proof.maxImageUnits;
  const microUsd = purpose.kind === 'text' ? sum(estimate(proof.maxInputTokens,price.inputMicroUsdPerMillion), estimate(proof.maxOutputTokens,price.outputMicroUsdPerMillion)) : estimate(units, price.imageMicroUsdPerUnit);
  return { calls:1,units,microUsd,price,proof };
}
