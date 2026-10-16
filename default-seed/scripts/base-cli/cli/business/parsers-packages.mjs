import { identifier, literal, packageName, splitOutside } from './parsers-syntax.mjs';

function requirement(value) {
 // In a direct reference, only the package before @ is a name. Bare URLs,
 // editable paths, index options and includes are deliberately not followed.
 const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s*(?:\[|[<>=!~;@]|\(|$))/.exec(value.trim());
 return match?.[1];
}

function jsonDependencies(source, sections, add) {
 let manifest;
 try { manifest = JSON.parse(source); } catch { return; }
 if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return;
 for (const section of sections) {
  const dependencies = manifest[section];
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
  for (const name of Object.keys(dependencies)) if (packageName.test(name)) add('package', name);
 }
}

function cargoDependencies(source, add) {
 let dependencyTable = false;
 for (const line of source.split(/\r?\n/)) {
  const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  if (header) {
   const table = header[1].trim();
   dependencyTable = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)$/.test(table);
   const detail = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$/.exec(table);
   if (detail) add('package', detail[1]);
   continue;
  }
  if (!dependencyTable) continue;
  const parts = splitOutside(line, '='); if (parts.length < 2) continue;
  const name = literal(parts.shift()); if (!name || !packageName.test(name)) continue;
  // Cargo renames name a different package explicitly inside an inline table.
  const renamed = /(?:^|[,\s{])package\s*=\s*(["'])([A-Za-z0-9_-]+)\1/.exec(parts.join('='));
  add('package', renamed?.[2] ?? name);
 }
}

function goDependencies(source, add) {
 let group = false;
 const name = '[A-Za-z0-9][A-Za-z0-9._~-]*(?:/[A-Za-z0-9][A-Za-z0-9._~-]*)+';
 for (const line of source.split(/\r?\n/)) {
  if (/^\s*require\s*\(\s*$/.test(line)) { group = true; continue; }
  if (group && /^\s*\)\s*$/.test(line)) { group = false; continue; }
  const match = new RegExp(group ? `^\\s*(${name})\\s+v[^\\s]+\\s*$` : `^\\s*require\\s+(${name})\\s+v[^\\s]+\\s*$`).exec(line);
  if (match) add('package', match[1]);
 }
}

export function packageNames(filename, source, entries, add) {
 if (filename === 'package.json') {
  jsonDependencies(source, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'], add);
 } else if (filename === 'composer.json') {
  jsonDependencies(source, ['require', 'require-dev'], add);
 } else if (/^requirements[^/]*\.txt$/.test(filename)) {
  for (const line of source.split(/\r?\n/)) { const name = requirement(line); if (name) add('package', name); }
 } else if (filename === 'pyproject.toml') {
  for (const { path, value } of entries) {
   if (typeof value === 'string' && ((path[0] === 'project' && path[1] === 'dependencies' && path[2] === '[]')
    || (path[0] === 'project' && path[1] === 'optional-dependencies' && path[3] === '[]'))) {
    const name = requirement(value); if (name) add('package', name);
   }
   const poetry = path[0] === 'tool' && path[1] === 'poetry';
   const dependencyIndex = poetry && (path[2] === 'dependencies' || path[2] === 'dev-dependencies') ? 3
    : poetry && path[2] === 'group' && path[4] === 'dependencies' ? 5 : -1;
   if (dependencyIndex !== -1 && path.length === dependencyIndex + 1 && path[dependencyIndex] !== 'python' && packageName.test(path[dependencyIndex])) add('package', path[dependencyIndex]);
  }
 } else if (filename === 'gemfile') {
  for (const line of source.split(/\r?\n/)) {
   const match = /^\s*gem\s*(?:\(\s*)?(["'])([A-Za-z0-9][A-Za-z0-9_.-]*)\1(?=\s*[,)]|\s*$)/.exec(line);
   if (match) add('package', match[2]);
  }
 } else if (filename === 'go.mod') goDependencies(source, add);
 else if (filename === 'cargo.toml') cargoDependencies(source, add);
}

export function environmentNames(source, add) {
 for (const line of source.split(/\r?\n/)) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (match && identifier.test(match[1])) add('env-key', match[1]);
 }
}
