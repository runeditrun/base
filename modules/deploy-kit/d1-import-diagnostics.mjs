import { transportReason } from './provider-transport.mjs';

// Import replies only need a bounded diagnostic prefix. A large refusal must
// keep its HTTP status rather than becoming a generic response-size failure.
export async function importResponseText(response, onReadError) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (length < 64 * 1024) {
      let part;
      try { part = await reader.read(); } catch (cause) { throw onReadError(cause); }
      if (part.done) break;
      const bytes = part.value.subarray(0,64 * 1024-length);
      chunks.push(bytes); length += bytes.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

// Redact complete provider text before bounding UTF-8 bytes. In particular a
// credential straddling the excerpt boundary must never become a public prefix.
export function importText(text, redact = String, limit = 2048) {
  const safe = redact(String(text)).replace(/\\\//g, '/').replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[URL omitted]')
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  let end = Math.min(safe.length, limit);
  while (Buffer.byteLength(safe.slice(0, end)) > limit) end--;
  // Do not leave a split surrogate at the end of an excerpt.
  if (/[\uD800-\uDBFF]/.test(safe[end - 1] ?? '')) end--;
  return safe.slice(0, end);
}

export function importDiagnostic(error, {step, status = null, body = '', payload, redact = String, cause}) {
  const xmlCode = /<Code>([^<]{1,120})<\/Code>/.exec(body)?.[1];
  const xmlMessage = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  const items = [payload?.error, ...(Array.isArray(payload?.errors) ? payload.errors : []),
    ...(xmlCode || xmlMessage ? [{code:xmlCode,message:xmlMessage}] : [])];
  const hasCode = code => Number.isSafeInteger(code) || typeof code === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(code);
  const errors = items.map(item => typeof item === 'string' ? {message:item} : item)
    .filter(item => hasCode(item?.code) || typeof item?.message === 'string').slice(0, 3)
    .map(item => ({...(hasCode(item.code) ? {code:typeof item.code === 'number' ? item.code : importText(item.code,redact,120)} : {}),
      ...(typeof item.message === 'string' ? {message:importText(item.message, redact, 300)} : {})}));
  error.status = status;
  error.d1Import = {step, status, errors, body:importText(payload === undefined ? body : JSON.stringify(payload), redact),
    ...(cause ? {causeCode:transportReason(cause)} : {})};
  return error;
}

export function importFailureText(error, redact = String) {
  const detail = error?.d1Import;
  if (!detail) return undefined;
  const said = detail.errors.map(item => [item.code, item.message].filter(value => value !== undefined).join(' ')).join('; ');
  return `D1 import ${detail.step}: ${detail.status === null ? 'no HTTP status' : `HTTP ${detail.status}`}`
    + (detail.causeCode ? ` (${detail.causeCode})` : '')
    + (said ? `; ${importText(said, redact, 1000)}` : '')
    + (detail.body ? `; response: ${importText(detail.body, redact)}` : '');
}
