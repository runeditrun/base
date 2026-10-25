import { sensitive, credentialShaped, blockedSignal } from './detector.mjs';

export function assertOutbound(value, knownSecrets = []) {
 function visit(item) {
  if (typeof item === 'string') {
   // Vendor records can contain ordinary line breaks. Inspect their text without
   // changing the bytes that will be uploaded. All credential/entropy rules apply.
   if (sensitive(item.replace(/[\r\n\t]/g, ' ')) || knownSecrets.some(secret => secret && item.includes(secret))) {
    throw Error('Business outbound detector refused secret-shaped content.');
   }
  } else if (Array.isArray(item)) item.forEach(visit);
  else if (item && typeof item === 'object') for (const [key, entry] of Object.entries(item)) { visit(key); visit(entry); }
 }
 visit(value);
}

/** A vendor export item bound for the owner's own app. Chunks may be fragments
 * of a JSON document, so the complete UTF-8 text is inspected before any network
 * write: the owner's key and every known credential shape are refused. The
 * entropy heuristic for names-only signals does not apply here: vendor records
 * are made of opaque ids, hashes and API links (Sentry's 32-hex event ids,
 * PagerDuty's `self` URLs), and they go only to the owner's own app. */
export function assertChunk(bytes, knownSecrets) {
 const text = Buffer.from(bytes).toString('utf8');
 if (credentialShaped(text.replace(/[\r\n\t]/g, ' ')) || knownSecrets.some(secret => secret && text.includes(secret))) throw Error('Business outbound detector refused secret-shaped content.');
}

// Names-only signals share the scanner's field-aware path policy. A locator
// joins ordinary directory names; credential shapes still apply across its
// entire spelling, and entropy is checked within each path segment.
export function assertSignals(document) {
 assertOutbound({ schema: document.schema, source: document.source, withheld: document.withheld });
 if (document.signals.some(blockedSignal)) throw Error('Business outbound detector refused secret-shaped content.');
}
