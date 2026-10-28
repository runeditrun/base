import { flowEntries, keyParts, literal, splitOutside } from './parsers-syntax.mjs';

export function yamlEntries(source) {
 const entries = [], stack = [];
 let blockIndent, multilineQuote = '';
 for (const line of source.split(/\r?\n/)) {
  if (multilineQuote) { multilineQuote = remainingQuote(line, multilineQuote); continue; }
  if (!line.trim() || /^\s*(?:---|\.\.\.)\s*$/.test(line)) continue;
  const indent = /^ */.exec(line)[0].length;
  if (blockIndent !== undefined) { if (indent > blockIndent) continue; blockIndent = undefined; }
  while (stack.length && indent <= stack.at(-1).indent) stack.pop();
  let raw = line.trim(), path = stack.at(-1)?.path ?? [], keyIndent = indent;
  if (raw.startsWith('- ')) {
   path = [...path, '[]']; raw = raw.slice(2).trim(); keyIndent += 2;
   stack.push({ indent, path });
  }
  if (raw.startsWith('{') || raw.startsWith('[')) { flowEntries(raw, path, ':', entries); continue; }
  const parts = splitOutside(raw, ':');
  if (parts.length < 2 || !/^\s/.test(parts[1]) && parts[1] !== '') {
   if (path.at(-1) === '[]') entries.push({ path, value: literal(raw) });
   continue;
  }
  const keys = keyParts(parts.shift()); if (!keys) continue;
  const child = [...path, ...keys], value = parts.join(':').trim();
  entries.push({ path: child, value: literal(value) });
  if (/^["']/.test(value)) { multilineQuote = remainingQuote(value); if (multilineQuote) continue; }
  if (/^[|>][+-]?[0-9]?$|^[|>][0-9][+-]?$/.test(value)) { blockIndent = keyIndent; continue; }
  if (!value || /^(?:&[A-Za-z0-9_-]+|![^ ]+)\s*$/.test(value)) stack.push({ indent: keyIndent, path: child });
  else flowEntries(value, child, ':', entries);
 }
 return entries;
}

function remainingQuote(source, initial = '') {
 let quote = initial;
 for (let i = 0; i < source.length; i++) {
  const char = source[i];
  if (quote) {
   if (char === '\\' && quote === '"') i++;
   else if (char === quote) {
    if (quote === "'" && source[i + 1] === "'") i++;
    else quote = '';
   }
  } else if (char === '"' || char === "'") quote = char;
 }
 return quote;
}

function statements(source) {
 const result = []; let current = '', quote = '', depth = 0, triple = false, start = 0;
 for (let i = 0; i < source.length; i++) {
  const char = source[i]; current += char;
  if (quote) {
   if (char === '\\' && quote === '"') { current += source[++i] ?? ''; }
   else if (triple && source.slice(i, i + 3) === quote.repeat(3)) { current += source.slice(i + 1, i + 3); i += 2; quote = ''; triple = false; }
   else if (!triple && char === quote) quote = '';
  } else if (char === '"' || char === "'") {
   quote = char;
   if (source.slice(i, i + 3) === char.repeat(3)) { triple = true; current += source.slice(i + 1, i + 3); i += 2; }
  } else if (char === '[' || char === '{') depth++;
  else if (char === ']' || char === '}') depth--;
  else if (char === '\n' && depth === 0) { result.push({text:current.trim(), offset:start + current.search(/\S/)}); current = ''; start = i + 1; }
 }
 if (current.trim()) result.push({text:current.trim(), offset:start + current.search(/\S/)}); return result;
}

export function tomlEntries(source, { locations = false } = {}) {
 const entries = []; let table = [];
 for (const {text:statement, offset} of statements(source)) {
  const header = /^(\[\[?)([\s\S]*?)(\]\]?)$/.exec(statement);
  if (header && header[1].length === header[3].length) {
   table = keyParts(header[2], true) ?? [];
   if (table.length) {
    entries.push({ path: table, value: undefined, ...(locations ? {offset} : {}) });
    if (header[1] === '[[') table = [...table, '[]'];
   }
   continue;
  }
  const parts = splitOutside(statement, '='); if (parts.length < 2) continue;
  const keys = keyParts(parts.shift(), true); if (!keys) continue;
  const path = [...table, ...keys], raw = parts.join('=').trim();
  entries.push({ path, value: literal(raw), ...(locations ? {offset} : {}) });
  flowEntries(raw, path, '=', entries, 0, locations ? offset + statement.indexOf('=') + 1 + parts.join('=').search(/\S/) : undefined);
 }
 return entries;
}

export function configNames(entries, add) {
 for (const { path } of entries) {
  if (path.at(-1) !== '[]') add('config-key', path.join('.'));
 }
}
