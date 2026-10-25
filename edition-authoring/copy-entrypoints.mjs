// Copy selection includes documents and data. Only Node entry points turn
// extensionless files into JavaScript; their spelling alone says nothing.
import path from 'node:path';

const code = new Set(['.js', '.mjs', '.cjs']);
const data = new Set(['.json', '.node', '.wasm', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.md', '.txt', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.pdf', '.yaml', '.yml', '.toml', '.sql', '.sh', '.py']);
const nodeShebang = bytes => /^#![^\r\n]*(?:\/|\s)node(?:\s|$)/.test(bytes.toString('utf8', 0, Math.min(bytes.length, 256)).split('\n', 1)[0]);

export function copyEntrypoints(read, tree) {
  const entries = new Set();
  // Do not parse every package manifest. Read only when a selected file could
  // be its entry point; wildcard exports are matched against that exact file.
  const manifests = new Map();
  const targets = name => {
    if (manifests.has(name)) return manifests.get(name);
    const entry = tree.get(name), result = [];
    if (entry) {
      const config = JSON.parse(read.blobs([entry.object]).get(entry.object).toString('utf8'));
      const collect = value => {
        if (typeof value === 'string') result.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
      };
      collect(config?.bin); collect(config?.main); collect(config?.exports);
    }
    manifests.set(name, result);
    return result;
  };
  return (name, bytes, imported = false) => {
    const extension = path.posix.extname(name);
    if (code.has(extension)) return true;
    if (data.has(extension)) return false;
    if (imported || nodeShebang(bytes) || entries.has(name)) return true;
    for (let directory = path.posix.dirname(name); ; directory = path.posix.dirname(directory)) {
      const relative = path.posix.relative(directory, name);
      if (targets(path.posix.join(directory, 'package.json')).some(target => {
        const normalized = target.replace(/^\.\//, '');
        const star = normalized.indexOf('*');
        return star < 0 ? normalized === relative : relative.startsWith(normalized.slice(0, star)) && relative.endsWith(normalized.slice(star + 1));
      })) { entries.add(name); return true; }
      if (directory === '.' || path.posix.basename(directory) === 'node_modules') break;
    }
    return false;
  };
}
