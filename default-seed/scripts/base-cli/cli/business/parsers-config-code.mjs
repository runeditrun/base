import { flowEntries } from './parsers-syntax.mjs';

// Consume templates as one string, including nested strings/templates inside
// interpolation. Unsupported expressions remain opaque through end-of-input.
export function codeStringEnd(source, start, depth = 0) {
 if (depth > 48) return source.length;
 const quote = source[start];
 for (let i = start + 1; i < source.length; i++) {
  if (source[i] === '\\') i++;
  else if (source[i] === quote) return i + 1;
  else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
   i = interpolationEnd(source, i + 2, depth + 1) - 1;
  }
 }
 return source.length;
}

function interpolationEnd(source, start, depth) {
 let braces = 1;
 for (let i = start; i < source.length; i++) {
  const char = source[i], next = source[i + 1];
  if (char === '"' || char === "'" || char === '`') i = codeStringEnd(source, i, depth) - 1;
  else if (char === '/' && next === '/') {
   const end = source.indexOf('\n', i + 2); if (end < 0) return source.length;
   i = end;
  } else if (char === '/' && next === '*') {
   const end = source.indexOf('*/', i + 2); if (end < 0) return source.length;
   i = end + 1;
  } else if (char === '/') {
   // A slash may start a regexp whose braces and backticks are literal.
   // Do not guess where an unsupported expression ends and expose its text.
   return source.length;
  } else if (char === '{') braces++;
  else if (char === '}' && --braces === 0) return i + 1;
 }
 return source.length;
}

function maskCodeStrings(source) {
 let masked = '', keys = '', previous = '';
 for (let i = 0; i < source.length; i++) {
  const char = source[i];
  if (char === '"' || char === "'" || char === '`') {
   const end = codeStringEnd(source, i), raw = source.slice(i, end);
   const blank = raw.replace(/[^\r\n]/g, ' ');
   // Only literal property names survive; value text never reaches splitting.
   const key = char !== '`' && (previous === '{' || previous === ',') && /^\s*:/.test(source.slice(end));
   masked += blank; keys += key ? raw : blank; previous = char; i = end - 1;
  } else {
   masked += char; keys += char;
   if (!/\s/.test(char)) previous = char;
  }
 }
 return { masked, keys };
}

// Read literal exported objects without importing a config or invoking its
// helpers. Strings are opaque when finding object boundaries.
export function configCodeEntries(source) {
 const { masked, keys } = maskCodeStrings(source), entries = [];
 const exported = /\b(?:module\.exports\s*=|export\s+default)\s*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*)?\{/g;
 for (const match of masked.matchAll(exported)) {
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 1, end = start + 1;
  for (; end < masked.length && depth; end++) {
   if (masked[end] === '{') depth++;
   else if (masked[end] === '}') depth--;
  }
  if (!depth) flowEntries(keys.slice(start, end), [], ':', entries);
 }
 return entries;
}
