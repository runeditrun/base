// These readers describe syntax only. They never resolve a tag, alias, include,
// interpolation or executable expression. Unsupported syntax contributes no value.
export const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*$/i;

export function literal(source) {
 const value = source.trim();
 if (value.startsWith('"')) {
  try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : undefined; } catch { return undefined; }
 }
 if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : undefined;
 return /^[^\s\[\]{},#'"`]+$/.test(value) ? value : undefined;
}

// Keep offsets/newlines, so a removed comment cannot join adjacent tokens.
// In YAML/TOML, # starts comments; // only starts comments in JSON/HCL/code.
export function comments(source, slash = false, stringEnd = undefined) {
 let clean = '', quote = '', block = false, comment = '';
 const traces = [];
 for (let i = 0; i < source.length; i++) {
  const char = source[i], next = source[i + 1];
  if (block) {
   if (char === '*' && next === '/') { traces.push(comment); comment = ''; block = false; clean += '  '; i++; }
   else { comment += char; clean += char === '\n' ? '\n' : ' '; }
  } else if (quote) {
   clean += char;
   if (char === '\\' && quote !== "'") { clean += next ?? ''; i++; }
   else if (char === quote) {
    if (quote === "'" && next === "'") { clean += next; i++; }
    else quote = '';
   }
  } else if (char === '"' || char === "'" || (slash && char === '`')) {
   if (stringEnd) {
    const end = stringEnd(source, i); clean += source.slice(i, end); i = end - 1;
   } else { quote = char; clean += char; }
  }
  else if (slash && char === '/' && next === '*') { block = true; clean += '  '; i++; }
  else if (char === '#' || (slash && char === '/' && next === '/')) {
   const start = i + (char === '#' ? 1 : 2);
   let end = source.indexOf('\n', start); if (end === -1) end = source.length;
   traces.push(source.slice(start, end)); clean += ' '.repeat(end - i); i = end - 1;
  } else clean += char;
 }
 if (block) traces.push(comment);
 return { clean, traces };
}

// Split delimiters outside strings and flow collections. No regexp can safely
// split an inline table containing a quoted comma or colon.
export function splitOutside(source, delimiter) {
 const result = []; let start = 0, quote = '', depth = 0;
 for (let i = 0; i < source.length; i++) {
  const char = source[i];
  if (quote) {
   if (char === '\\' && quote === '"') i++;
   else if (char === quote) {
    if (quote === "'" && source[i + 1] === "'") i++;
    else quote = '';
   }
  } else if (char === '"' || char === "'") quote = char;
  else if (char === '[' || char === '{') depth++;
  else if (char === ']' || char === '}') depth--;
  else if (char === delimiter && depth === 0) { result.push(source.slice(start, i)); start = i + 1; }
 }
 result.push(source.slice(start)); return result;
}

export function keyParts(source, dotted = false) {
 const pieces = dotted ? splitOutside(source, '.') : [source];
 const result = pieces.map(piece => {
  const trimmed = piece.trim(), value = literal(trimmed);
  return value && (/^["']/.test(trimmed) || identifier.test(value)) ? value : undefined;
 });
 return result.length && result.every(part => part !== undefined) ? result : undefined;
}

export function flowEntries(source, path, delimiter, entries, depth = 0) {
 if (depth > 48) return;
 const value = source.trim();
 if (value.startsWith('{') && value.endsWith('}')) {
  for (const pair of splitOutside(value.slice(1, -1), ',')) {
   const parts = splitOutside(pair, delimiter); if (parts.length < 2) continue;
   const keys = keyParts(parts.shift(), delimiter === '='); if (!keys) continue;
   const child = [...path, ...keys], raw = parts.join(delimiter).trim();
   entries.push({ path: child, value: literal(raw) }); flowEntries(raw, child, delimiter, entries, depth + 1);
  }
 } else if (value.startsWith('[') && value.endsWith(']')) {
  for (const item of splitOutside(value.slice(1, -1), ',')) {
   const child = [...path, '[]']; entries.push({ path: child, value: literal(item) });
   flowEntries(item, child, delimiter, entries, depth + 1);
  }
 }
}

export function jsonEntries(source) {
 let root;
 try { root = JSON.parse(source); } catch { return []; }
 const entries = [], pending = [{ value: root, path: [] }];
 while (pending.length) {
  const { value, path } = pending.pop(); if (path.length > 48) continue;
  if (Array.isArray(value)) {
   for (const child of value) {
    const next = [...path, '[]']; entries.push({ path: next, value: typeof child === 'string' ? child : undefined });
    if (child && typeof child === 'object') pending.push({ path: next, value: child });
   }
  } else if (value && typeof value === 'object') {
   for (const [key, child] of Object.entries(value)) {
    // JSON object keys are names, including quoted names with spaces. The
    // caller applies its output detector to every candidate, including keys.
    if (!key) continue;
    const next = [...path, key]; entries.push({ path: next, value: typeof child === 'string' ? child : undefined });
    if (child && typeof child === 'object') pending.push({ path: next, value: child });
   }
  }
 }
 return entries;
}
