// A terminal may wrap a registered credential inside its bytes. Retain the
// original offsets so both complete masks and streaming holds cover the wrap.
export function compactSecretText(text) {
 const offsets = [], ends = [], characters = [];
 for (let at = 0; at < text.length;) {
  const start = at;
  let character = text[at++];
  // URL encoders may escape even unreserved ASCII, or encode a URL twice.
  // Decode with source offsets so mixed encoded/plain key bytes also match.
  if (character === '%' && /^[0-9a-f]{2}/i.test(text.slice(at, at + 2))) {
   character = String.fromCharCode(parseInt(text.slice(at, at + 2), 16)); at += 2;
   if (character === '%' && /^[0-9a-f]{2}/i.test(text.slice(at, at + 2))) { character = String.fromCharCode(parseInt(text.slice(at, at + 2), 16)); at += 2; }
  }
  if (!/\s/.test(character)) { offsets.push(start); ends.push(at); characters.push(character); }
 }
 const compact = characters.join('');
 return {
  ranges(secrets) {
   const ranges = [];
   for (const secret of secrets) {
    if (/\s/.test(secret)) continue;
    let at = 0;
    while ((at = compact.indexOf(secret, at)) >= 0) { ranges.push([offsets[at], ends[at + secret.length - 1]]); at++; }
   }
   return ranges;
  },
  prefix(secrets, minimum) {
   let cutoff = text.length;
   for (const secret of secrets) {
    if (/\s/.test(secret)) continue;
    for (let at = Math.max(0, compact.length - secret.length + 1); at <= compact.length - minimum; at++) {
     if (secret.startsWith(compact.slice(at))) { cutoff = Math.min(cutoff, offsets[at]); break; }
    }
   }
   return cutoff;
  },
 };
}
