import { flowEntries } from './parsers-syntax.mjs';
import { maskStrings } from './parsers-pulumi.mjs';

// Read literal exported objects without importing a config or invoking its
// helpers. Strings are opaque when finding object boundaries.
export function configCodeEntries(source) {
 const masked = maskStrings(source), entries = [];
 const exported = /\b(?:module\.exports\s*=|export\s+default)\s*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*)?\{/g;
 for (const match of masked.matchAll(exported)) {
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 1, end = start + 1;
  for (; end < masked.length && depth; end++) {
   if (masked[end] === '{') depth++;
   else if (masked[end] === '}') depth--;
  }
  if (!depth) flowEntries(source.slice(start, end), [], ':', entries);
 }
 return entries;
}
