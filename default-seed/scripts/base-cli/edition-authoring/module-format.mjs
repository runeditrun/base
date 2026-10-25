// Node package scopes, read only from the immutable origin commit. A nearest
// typeless package still ends the search; never consult the seed or checkout.
import path from 'node:path';
import {packageMetadata} from './package-metadata.mjs';

export const javascript = name => ['', '.js', '.mjs', '.cjs'].includes(path.posix.extname(name));

export function moduleFormats(read, revision) {
  const scopes = new Map();
  const scope = directory => {
    if (scopes.has(directory)) return scopes.get(directory);
    let format = 'auto';
    if (path.posix.basename(directory) !== 'node_modules') {
      const name = path.posix.join(directory, 'package.json');
      const entry = read.entry(revision, name);
      if (entry) {
        if (!['100644', '100755'].includes(entry.mode)) throw Error(`Cannot determine package scope from non-regular ${name} at ${revision}`);
        let config;
        try {
          config = packageMetadata(new TextDecoder().decode(read.blobs([entry.object]).get(entry.object)));
        } catch (error) { throw Error(`Invalid package configuration ${name} at ${revision}: ${error.message}`); }
        if (config.type === 'module' || config.type === 'commonjs') format = config.type;
      } else if (directory !== '.') format = scope(path.posix.dirname(directory));
    }
    scopes.set(directory, format);
    return format;
  };
  return name => {
    const extension = path.posix.extname(name);
    if (extension === '.mjs') return 'module';
    if (extension === '.cjs') return 'commonjs';
    return scope(path.posix.dirname(name));
  };
}
