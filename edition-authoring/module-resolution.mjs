import path from 'node:path';

const declaration = name => /\.d\.[cm]?ts$/.test(name);
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

// Every import kind uses this resolver. Runtime JS follows Node's file/require
// rules; source TS also recognizes filenames produced by its compiler. An
// erased type edge is the only route that can resolve a declaration file.
// Package-name imports belong to the edition's package manager, not this graph.
export function resolve(tree, source, specifier, {types = false, kind = 'import'} = {}) {
  if (!specifier.startsWith('.')) return;
  const name = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier.split(/[?#]/)[0]));
  const sourceModule = /\.(?:[cm]?ts|[jt]sx)$/.test(source);
  const file = candidate => (types || !declaration(candidate)) && tree.has(candidate) ? candidate : undefined;
  const direct = file(name);
  if (direct) return direct;
  const extension = path.posix.extname(name);
  if (sourceModule || types) {
    const replacements = {'.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts']}[extension] ?? [];
    if (types) replacements.push(...({'.js': ['.d.ts'], '.mjs': ['.d.mts'], '.cjs': ['.d.cts']}[extension] ?? []));
    for (const replacement of replacements) {
      const found = file(name.slice(0, -extension.length) + replacement);
      if (found) return found;
    }
  }
  if (sourceModule || types || kind === 'require') {
    const suffixes = sourceModule || types ? [...sourceExtensions, ...(types ? ['.d.ts', '.d.mts', '.d.cts'] : [])] : ['.js', '.json', '.node'];
    for (const suffix of suffixes) {
      const found = file(name + suffix);
      if (found) return found;
    }
    // Relative require-directory resolution consults main, never types/typings
    // or exports. Node only consults exports when resolving a package name.
    const manifest = name + '/package.json';
    if (kind === 'require' && tree.has(manifest) && tree.read) {
      const main = JSON.parse(tree.read(manifest)).main;
      if (typeof main === 'string') {
        const target = path.posix.join(name, main);
        for (const candidate of [target, ...['.js', '.json', '.node'].map(suffix => target + suffix), ...['.js', '.json', '.node'].map(suffix => target + '/index' + suffix)]) {
          const found = file(candidate);
          if (found) return found;
        }
      }
    }
    for (const suffix of suffixes) {
      const found = file(name + '/index' + suffix);
      if (found) return found;
    }
  }
}
