// Resolve the built seed's CSS before serving the gate: no stylesheet round
// trips, and relative imports/font/mark URLs still refer to their source file.
const origin = 'https://theme.invalid';
const imports = /@import\s+(?:url\(\s*(['"]?)([^'"\s)]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;

function localURL(value, path) {
  const url = new URL(value, origin + path);
  if (url.origin !== origin) throw Error(`Demo theme must use same-origin assets: ${value}`);
  return url.pathname + url.search + url.hash;
}

function conditioned(css, conditions) {
  // @import allows layer, supports, then media; keep their cascade semantics.
  const wrappers = [];
  let rest = conditions.trim();
  for (const kind of ['layer', 'supports']) {
    if (!rest.startsWith(kind)) continue;
    rest = rest.slice(kind.length).trimStart();
    let value = '';
    if (rest.startsWith('(')) {
      let depth = 0, end = 0;
      do { if (rest[end] === '(') depth++; if (rest[end] === ')') depth--; end++; } while (depth && end < rest.length);
      if (depth) throw Error(`Invalid demo theme import: ${conditions}`);
      value = rest.slice(1, end - 1); rest = rest.slice(end).trimStart();
    } else if (kind === 'supports') throw Error(`Invalid demo theme import: ${conditions}`);
    wrappers.push(kind === 'supports' ? `@supports (${value})` : `@layer ${value}`);
  }
  if (rest) wrappers.push(`@media ${rest}`);
  return wrappers.reduceRight((body, wrapper) => `${wrapper}{${body}}`, css);
}

export function inlineTheme(files, paths) {
  function expand(path, parents = []) {
    const key = new URL(path, origin).pathname;
    if (parents.includes(key)) throw Error(`Cyclic demo theme import: ${[...parents, key].join(' -> ')}`);
    const bytes = files.get(key);
    if (!bytes) throw Error(`Demo theme asset missing: ${key}`);
    const css = bytes.toString().replace(/\/\*[\s\S]*?\*\//g, '').replace(/@charset\s+['"][^'"]+['"]\s*;/gi, '');
    // Rebase before expansion so an imported file keeps its own URL base.
    const rebased = css.replace(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/gi, (_, _quote, value) => `url("${localURL(value, key)}")`);
    return rebased.replace(imports, (_, _q1, url, _q2, string, conditions) => conditioned(expand(localURL(url ?? string, key), [...parents, key]), conditions));
  }
  return paths.map(path => expand(path)).join('\n').replace(/@font-face\s*\{([^{}]*)\}/gi, (_, body) => {
    // A seed's block/auto/default display must not hold the gate's first paint.
    const declarations = body.replace(/font-display\s*:[^;}]*(;|$)/gi, '');
    const display = /font-display\s*:\s*optional\s*(?:;|$)/i.test(body) ? 'optional' : 'swap';
    return `@font-face{${declarations.trim().replace(/;?$/, ';')}font-display:${display};}`;
  });
}
