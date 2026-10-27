import path from 'node:path';


// Tokenize enough module syntax to ignore comments and quoted page/CSS content.
// Static imports (including type imports), re-exports and literal import() /
// require() calls share the same relative resolution below. Templates are page
// content, never static module declarations.
export function specifiers(source) {
  const tokens = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|[\w$]+|[^\s]/g)]
    .map(match => match[0]).filter(token => !token.startsWith('//') && !token.startsWith('/*') && !token.startsWith('`'));
  const result = [];
  const literal = token => /^['"]\.{1,2}\//.test(token || '') ? token.slice(1, -1) : null;
  for (let i = 0; i < tokens.length; i++) {
    if (!['import', 'export', 'require'].includes(tokens[i])) continue;
    if (tokens[i - 1] === '.' || (tokens[i] === 'require' && tokens[i + 1] !== '(')) continue;
    if (tokens[i] === 'export' && !['{', '*', 'type'].includes(tokens[i + 1])) continue;
    let value = literal(tokens[i + 1]);
    if (tokens[i + 1] === '(') value = literal(tokens[i + 2]);
    else if (!value) {
      for (let j = i + 1; j < tokens.length && ![';', 'import', 'export'].includes(tokens[j]); j++) {
        if (tokens[j] === 'from') { value = literal(tokens[j + 1]); break; }
      }
    }
    if (value) result.push(value.split('?')[0]);
  }
  return result;
}

export function resolve(tree, source, specifier) {
  const name = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier.split('?')[0]));
  const candidates = [name];
  // TypeScript source commonly uses its emitted JS extension in imports.
  const replacement = {'.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts']}[path.posix.extname(name)];
  if (replacement) candidates.push(...replacement.map(extension => name.slice(0, -path.posix.extname(name).length) + extension));
  if (!/\.(?:[cm]?[jt]s|[jt]sx|json)$/.test(name)) {
    for (const suffix of ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.cts', '.cjs', '.json']) candidates.push(name + suffix, name + '/index' + suffix);
  }
  const found = candidates.find(candidate => tree.has(candidate));
  return found;
}

// Binding checks are lexical: unknown export forms remain unknown, never absent.
const tokens = source => [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|[\w$]+|[^\s]/g)]
  .map(match => match[0]).filter(token => !/^(?:\/\/|\/\*|`)/.test(token));
const unquote = value => /^['"]/.test(value ?? '') ? value.slice(1, -1) : null;
export function bindings(source, types = false) {
  const t = tokens(source), result = new Map();
  for (let i = 0; i < t.length; i++) {
    if (!['import', 'export'].includes(t[i]) || ['.', '('].includes(t[i + 1])) continue;
    let end = i + 1;
    while (end < t.length && ![';', 'import', 'export'].includes(t[end]) && t[end] !== 'from') end++;
    if (t[end] !== 'from') continue;
    const specifier = unquote(t[end + 1])?.split('?')[0];
    if (!specifier?.startsWith('.')) continue;
    const names = new Set(result.get(specifier) ?? []);
    let start = i + 1;
    const declarationType = t[start] === 'type';
    if (declarationType) start++;
    if (declarationType === types && t[i] === 'import' && /^[\w$]+$/.test(t[start] ?? '') && t[start] !== 'from') names.add('default');
    const open = t.indexOf('{', start);
    if (open >= 0 && open < end) for (let j = open + 1; j < end && t[j] !== '}'; j++) {
      if (t[j] === ',') continue;
      const inlineType = t[j] === 'type' && /^[\w$]+$/.test(t[j + 1] ?? '') && t[j + 1] !== 'as';
      if (inlineType) j++;
      if ((declarationType || inlineType) === types) names.add(unquote(t[j]) ?? t[j]);
      if (t[j + 1] === 'as') j += 2;
    }
    result.set(specifier, names);
  }
  return result;
}
export function lexicalExports(source, star, types = false) {
  const t = tokens(source), names = new Set();
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'export') continue;
    let j = i + 1;
    if (t[j] === 'default') { if (types || !['interface', 'type'].includes(t[j + 1])) names.add('default'); continue; }
    const declared = t[j] === 'declare';
    if (declared) j++;
    if (t[j] === 'async') j++;
    if (['const', 'let', 'var'].includes(t[j]) && ['{', '['].includes(t[j + 1])) return null;
    if (['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace'].includes(t[j]) && t[j + 1] !== '{') {
      if (!types && (declared || ['interface', 'type'].includes(t[j]))) continue;
      const name = t[j] === 'function' && t[j + 1] === '*' ? t[j + 2] : t[j + 1];
      if (!/^[\w$]+$/.test(name ?? '')) return null;
      names.add(name);
      if (['const', 'let', 'var'].includes(t[j])) {
        let depth = 0;
        for (let k = j + 2; k < t.length; k++) {
          if (!depth && [';', 'export', 'import'].includes(t[k])) break;
          if (['(', '[', '{'].includes(t[k])) depth++;
          if ([')', ']', '}'].includes(t[k])) depth--;
          if (!depth && t[k] === ',') {
            if (!/^[\w$]+$/.test(t[k + 1] ?? '') || !['=', ':'].includes(t[k + 2])) return null;
            names.add(t[k + 1]);
          }
        }
      }
      continue;
    }
    const declarationType = t[j] === 'type';
    if (declarationType) {
      if (!types) continue;
      j++;
    }
    if (t[j] === '*') {
      if (t[j + 1] === 'as') { names.add(t[j + 2]); continue; }
      const specifier = unquote(t[j + 2]);
      if (!specifier?.startsWith('.')) return null;
      const inherited = star(specifier);
      if (inherited === null) return null;
      for (const name of inherited) if (name !== 'default') names.add(name);
    }
    if (t[j] === '{') for (j++; j < t.length && t[j] !== '}'; j++) {
      if (t[j] === ',') continue;
      const inlineType = t[j] === 'type' && /^[\w$]+$/.test(t[j + 1] ?? '') && t[j + 1] !== 'as';
      if (inlineType) { j++; if (!types) { if (t[j + 1] === 'as') j += 2; continue; } }
      if (t[j + 1] === 'as') { names.add(unquote(t[j + 2]) ?? t[j + 2]); j += 2; }
      else names.add(unquote(t[j]) ?? t[j]);
    }
  }
  return names;
}
