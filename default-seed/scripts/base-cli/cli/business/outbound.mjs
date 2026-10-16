import { sensitive, blockedSignal } from './detector.mjs';

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

export function assertChunk(bytes, knownSecrets) {
 // Chunks may be fragments of a JSON document. The detector sees the complete
 // UTF-8 text before any network write, including names and record values.
 assertOutbound(Buffer.from(bytes).toString('utf8'), knownSecrets);
}

// Names-only signals share the scanner's field-aware path policy. A locator
// joins ordinary directory names; credential shapes still apply across its
// entire spelling, and entropy is checked within each path segment.
export function assertSignals(document) {
 assertOutbound({ schema: document.schema, source: document.source, withheld: document.withheld });
 if (document.signals.some(blockedSignal)) throw Error('Business outbound detector refused secret-shaped content.');
}
