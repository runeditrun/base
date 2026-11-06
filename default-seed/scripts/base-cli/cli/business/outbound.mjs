import { sensitive, blockedSignal } from './detector.mjs';

export function assertOutbound(value, knownSecrets = []) {
 function visit(item) {
  if (typeof item === 'string') {
   // Inspect text with line breaks as ordinary spaces; all credential/entropy rules apply.
   if (sensitive(item.replace(/[\r\n\t]/g, ' ')) || knownSecrets.some(secret => secret && item.includes(secret))) {
    throw Error('Business outbound detector refused secret-shaped content.');
   }
  } else if (Array.isArray(item)) item.forEach(visit);
  else if (item && typeof item === 'object') for (const [key, entry] of Object.entries(item)) { visit(key); visit(entry); }
 }
 visit(value);
}

// Names-only signals share the scanner's field-aware path policy. A locator
// joins ordinary directory names; credential shapes still apply across its
// entire spelling, and entropy is checked within each path segment.
export function assertSignals(document) {
 assertOutbound({ schema: document.schema, source: document.source, withheld: document.withheld });
 if (document.signals.some(blockedSignal)) throw Error('Business outbound detector refused secret-shaped content.');
}
