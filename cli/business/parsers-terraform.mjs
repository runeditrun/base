function tokens(source) {
 const result = [];
 for (let i = 0; i < source.length;) {
  if (/\s/.test(source[i])) { i++; continue; }
  if (source.slice(i, i + 2) === '<<') {
   const marker = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[^\S\n]*\r?\n/.exec(source.slice(i));
   if (marker) {
    i += marker[0].length;
    while (i < source.length) {
     let end = source.indexOf('\n', i); if (end === -1) end = source.length;
     const line = source.slice(i, end).trim(); i = end + 1;
     if (line === marker[1]) break;
    }
    continue;
   }
  }
  if (source[i] === '"') {
   let end = i + 1;
   for (; end < source.length; end++) {
    if (source[end] === '\\') end++;
    else if (source[end] === '"') { end++; break; }
   }
   let value; try { value = JSON.parse(source.slice(i, end)); } catch { /* Opaque malformed string. */ }
   result.push({ type: 'string', value }); i = end; continue;
  }
  const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i));
  if (word) { result.push({ type: 'word', value: word[0] }); i += word[0].length; }
  else { result.push({ type: source[i], value: source[i] }); i++; }
 }
 return result;
}

export function terraformNames(source, add) {
 const syntax = tokens(source), stack = [];
 for (let i = 0; i < syntax.length; i++) {
  const token = syntax[i];
  if (token.type === '{') { stack.push(syntax[i - 1]?.value === 'required_providers'); continue; }
  if (token.type === '}') { stack.pop(); continue; }
  if (token.type !== 'word') continue;
  if (['provider', 'resource', 'data'].includes(token.value) && syntax[i + 1]?.type === 'string') {
   const label = syntax[i + 1].value, next = i + (token.value === 'provider' ? 2 : 3);
   if (typeof label === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(label) && syntax[next]?.type === '{'
    && (token.value === 'provider' || syntax[i + 2]?.type === 'string')) {
    add(token.value === 'provider' ? 'iac-provider' : 'iac-resource', label);
   }
  }
  if (stack.at(-1) && syntax[i + 1]?.type === '=' && syntax[i + 2]?.type === '{') add('iac-provider', token.value);
  if (stack.includes(true) && token.value === 'source' && syntax[i + 1]?.type === '=' && syntax[i + 2]?.type === 'string') {
   const value = syntax[i + 2].value;
   if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){1,2}$/.test(value)) add('iac-provider', value);
  }
 }
}
