import path from 'node:path';

const declaration = name => /\.d\.[cm]?ts$/.test(name);
const runtime = ['.js', '.json', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx'];

// All import kinds use this resolver. TypeScript source substitutions describe
// emitted filenames; declarations are eligible only for an erased type edge.
// Package-name imports belong to the edition's package manager, not this graph.
export function resolve(tree, source, specifier, {types = false, kind = 'import'} = {}) {
  if (!specifier.startsWith('.')) return;
  const name = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier.split(/[?#]/)[0]));
  const file = candidate => (types || !declaration(candidate)) && tree.has(candidate) ? candidate : undefined;
  const direct = file(name);
  if (direct) return direct;
  const extension = path.posix.extname(name);
  const replacements = {'.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts']}[extension] ?? [];
  if (types) replacements.push(...({'.js': ['.d.ts'], '.mjs': ['.d.mts'], '.cjs': ['.d.cts']}[extension] ?? []));
  for (const replacement of replacements) {
    const found = file(name.slice(0, -extension.length) + replacement);
    if (found) return found;
  }
  if (!/\.(?:[cm]?[jt]s|[jt]sx|json)$/.test(name)) {
    for (const suffix of [...runtime, ...(types ? ['.d.ts', '.d.mts', '.d.cts'] : [])]) {
      const found = file(name + suffix);
      if (found) return found;
    }
    // Node's relative require-directory algorithm consults main, never types,
    // typings or exports. Package exports apply to package names only.
    const manifest = name + '/package.json';
    if (kind === 'require' && tree.has(manifest) && tree.read) {
      const main = JSON.parse(tree.read(manifest)).main;
      if (typeof main === 'string') {
        const target = path.posix.join(name, main);
        for (const candidate of [target, ...['.js', '.json'].map(suffix => target + suffix), ...['.js', '.json'].map(suffix => target + '/index' + suffix)]) {
          const found = file(candidate);
          if (found) return found;
        }
      }
    }
    // Extensionless authoring sources also include bundler-resolved indexes.
    for (const suffix of [...runtime, ...(types ? ['.d.ts', '.d.mts', '.d.cts'] : [])]) {
      const found = file(name + '/index' + suffix);
      if (found) return found;
    }
  }
}
