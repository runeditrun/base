import { redact } from './errors.mjs';
import { commandMask } from './run-mask.mjs';

const secretField = /credential|secret|token|password|cookie|authorization|headers|(?:api|private)[_-]?key|(?:user|device)[_-]?code/i;
const prose = ['message', 'error', 'detail', 'gap'];

// Read prose only. Secret-bearing siblings are used solely to mask reflected
// values (including encodings); neither their keys nor their values are output.
export function refusalView(body, limit = 500, secrets = []) {
 const objectText = value => typeof value === 'string' && /^\s*[\[{]/.test(value);
 const parse = value => { try { return JSON.parse(value); } catch { return null; } };
 function collect(value, hidden = false) {
  if (typeof value === 'string') {
   if (hidden && value) secrets.push(value);
   if (objectText(value)) collect(parse(value), hidden);
   return;
  }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) collect(child, hidden || secretField.test(key));
 }
 collect(body);
 const mask = commandMask(secrets);
 const line = value => typeof value === 'string' && !objectText(value) ? redact(mask.text(value)).replace(/\b[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}\b/g, '[credential]').replace(/\s+/g, ' ').trim() : '';
 const cap = value => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
 const sentences = value => objectText(value) ? sentences(parse(value)) : Array.isArray(value) ? value.flatMap(sentences)
  : value && typeof value === 'object' ? [...prose.flatMap(key => sentences(value[key])), ...(value.data && typeof value.data === 'object' ? sentences(value.data) : [])]
  : [line(value)];
 const values = sentences(body).filter(Boolean);
 return { sentence: cap([...new Set(values)].join(' ')), line: value => cap(line(value)) };
}

export const serverSaid = reason => reason ? ` The server said: ${reason}${/[.!?…]$/.test(reason) ? '' : '.'}` : '';

// Refusal JSON has the same useful status/action/code and reason as the human
// line, plus the refusal's other top-level scalar fields (a reconnect_url the agent
// must hand to the owner), without arbitrary nested data or credential-bearing fields.
const handled = new Set(['status', 'code', 'action', 'message', 'error', 'detail', 'gap', 'isError']);
export function refusalData(body) {
 const view = refusalView(body);
 return Object.fromEntries([
  ...['status', 'code', 'action'].filter(key => typeof body?.[key] === 'string').map(key => [key, view.line(body[key]).slice(0, 80)]),
  ...(view.sentence ? [['message', view.sentence]] : []),
  ...Object.entries(body ?? {}).filter(([key, value]) => !handled.has(key) && !secretField.test(key) && value !== null && ['string', 'number', 'boolean'].includes(typeof value) && !(typeof value === 'string' && !view.line(value))).map(([key, value]) => [key, typeof value === 'string' ? view.line(value) : value]),
 ]);
}

export function toolRefusal(result) {
 const body = result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : {};
 const texts = result?.content?.filter?.(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text) ?? [];
 return refusalData({ ...result, ...body, detail: [body.detail, ...texts.filter(value => !prose.some(key => body[key] === value))] });
}
