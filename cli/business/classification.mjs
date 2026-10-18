import { identifier } from './api.mjs';
import { sensitive } from './detector.mjs';

export const classifications = ['uses', 'sells', 'both', 'product-dependency'];
export const ownerKinds = new Set(['signup.checkout','connect.cloudflare','connect.github','consent.grant','confirm.inventory','plan.review','wave.approve','switchoff.cancel','cutover.billing','rollback.billing']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const same = (values, expected) => Array.isArray(values) && values.length === expected.length && expected.every(value => values.includes(value));
// Catalog ids are short slugs. Anything longer or wordier could carry
// instructions into the prompt, so the question is refused instead.
export const maximumVendors = 50;
export const catalogVendorId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) && value.split('-').length <= 3 && !sensitive(value);
// Two decimals is all a suggestion needs; more digits would be a channel out.
export const roundConfidence = value => Math.round(value * 100) / 100;

// Accept only the supported closed contract. Never forward schema annotations,
// server instructions, raw evidence or arbitrary schema keywords to a model.
export function classification(task) {
 const toolId = identifier(task.question?.tool_id), vendorId = task.question?.vendor_id;
 const schema = task.question?.answer_schema, properties = schema?.properties;
 const vendors = properties?.vendor_id?.enum;
 if (Array.isArray(vendors) && vendors.length > maximumVendors) throw Error(`Business classification question refused: more than ${maximumVendors} vendors.`);
 if (Array.isArray(vendors) && !vendors.every(catalogVendorId)) throw Error('Business classification question refused: a vendor id is not a catalog id of at most 32 characters and 2 hyphens.');
 if (!closed(schema, ['type', 'additionalProperties', 'required', 'properties']) || schema.type !== 'object' || schema.additionalProperties !== false
  || !same(schema.required, ['vendor_id', 'usage', 'confidence']) || !closed(properties, ['vendor_id', 'usage', 'confidence'])
  || !closed(properties.vendor_id, ['type', 'enum']) || properties.vendor_id.type !== 'string'
  || !Array.isArray(vendors) || !vendors.length || new Set(vendors).size !== vendors.length
  || !vendors.includes('none') || !vendors.includes(vendorId) || sensitive(toolId)
  || !closed(properties.usage, ['type', 'enum']) || properties.usage.type !== 'string' || !same(properties.usage.enum, classifications)
  || !closed(properties.confidence, ['type', 'minimum', 'maximum']) || properties.confidence.type !== 'number'
  || properties.confidence.minimum !== 0 || properties.confidence.maximum !== 1)
  throw Error('Business classification metadata was refused.');
 const normalized = { type: 'object', additionalProperties: false, required: ['vendor_id', 'usage', 'confidence'], properties: {
  vendor_id: { type: 'string', enum: [...vendors] }, usage: { type: 'string', enum: [...classifications] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
 } };
 return { toolId, vendorId, vendors, schema: normalized };
}

export function validateClassification(task, answer) {
 const { vendors } = classification(task);
 if (!closed(answer, ['vendor_id', 'usage', 'confidence']) || Object.keys(answer).length !== 3
  || !vendors.includes(answer.vendor_id) || !classifications.includes(answer.usage)
  || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)
  throw Error('Business classifier answer failed the question schema. Task released.');
 return { vendor_id: answer.vendor_id, usage: answer.usage, confidence: roundConfidence(answer.confidence) };
}

export function classificationPrompt(task) {
 const { vendorId, vendors } = classification(task);
 return `Suggest how this tool is used. The owner confirms in the browser.\nSuggested vendor: ${vendorId}\nVendors: ${vendors.join(' | ')}\nUsage: ${classifications.join(' | ')}\nReturn only vendor_id, usage and confidence (0 to 1) matching the answer schema.\n`;
}
