import {tokens, unquote} from './module-syntax.mjs';
export {resolve} from './module-resolution.mjs';

// Module edges retain their import kind and erased-type status before resolving.
// Bindings are checked separately: a namespace or side-effect edge has no named
// bindings, but has exactly the same runtime dependency as a named import.
export function dependencies(source) {
  const t = tokens(source), result = [];
  const add = (token, kind, types = false) => {
    const specifier = unquote(token);
    if (specifier?.startsWith('.')) result.push({specifier: kind === 'require' ? specifier : specifier.split(/[?#]/)[0], kind, types});
  };
  for (let i = 0; i < t.length; i++) {
    const word = t[i];
    if (word === 'module' && t[i + 1] === '[' && unquote(t[i + 2]) === 'require' && t[i + 3] === ']' && t[i + 4] === '(') add(t[i + 5], 'require');
    if (!['import', 'export', 'require'].includes(word)) continue;
    if (t[i - 1] === '.' && !(word === 'require' && t[i - 2] === 'module')) continue;
    if (word === 'require') {
      if (t[i + 1] === '(') add(t[i + 2], 'require');
      else if (t[i + 1] === '.' && t[i + 2] === 'resolve' && t[i + 3] === '(') add(t[i + 4], 'require');
      continue;
    }
    if (word === 'import' && t[i + 1] === '(') { add(t[i + 2], 'import'); continue; }
    if (word === 'import' && unquote(t[i + 1]) !== null) { add(t[i + 1], 'import'); continue; }
    if (word === 'export' && !['{', '*', 'type'].includes(t[i + 1])) continue;
    let end = i + 1;
    while (end < t.length && ![';', 'import', 'export', 'from'].includes(t[end])) end++;
    if (t[end] !== 'from') continue;
    const clause = t.slice(i + 1, end);
    const erased = clause[0] === 'type' && clause.length > 1 && clause[1] !== ',' || clause[0] === '{' && clause.at(-1) === '}' &&
      clause.slice(1, -1).length > 0 && clause.slice(1, -1).join(' ').split(' , ').every(item => item.startsWith('type ') && !item.startsWith('type as '));
    add(t[end + 1], 'import', erased);
  }
  return result;
}
export const specifiers = source => dependencies(source).map(edge => edge.specifier);

// Binding checks are lexical: unknown export forms remain unknown, never absent.
export function bindings(source, types = false) {
  const t = tokens(source), result = new Map();
  for (let i = 0; i < t.length; i++) {
    if (!['import', 'export'].includes(t[i]) || ['.', '('].includes(t[i + 1])) continue;
    let end = i + 1;
    while (end < t.length && ![';', 'import', 'export'].includes(t[end]) && t[end] !== 'from') end++;
    if (t[end] !== 'from') continue;
    const specifier = unquote(t[end + 1])?.split(/[?#]/)[0];
    if (!specifier?.startsWith('.')) continue;
    const names = new Set(result.get(specifier) ?? []);
    let start = i + 1;
    const declarationType = t[start] === 'type' && start + 1 < end && t[start + 1] !== ',';
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
