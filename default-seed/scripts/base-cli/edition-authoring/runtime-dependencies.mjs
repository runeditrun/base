// Keep partial and single-file runtime copies closed over their relative imports.
// Both maintained exporters already ship the whole foundation/runtime directory;
// refresh must also recover siblings omitted by an older seed's copy selection.
import path from 'node:path';

const runtime = 'foundation/runtime/';
const code = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const inside = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const mapped = (name, from, to) => to + name.slice(from.length);

// Tokenize enough module syntax to ignore comments and quoted page/CSS content.
// Static imports (including type imports), re-exports and literal import() /
// require() calls share the same relative resolution below. Templates are page
// content, never static module declarations.
function specifiers(source) {
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
    if (value) result.push(value);
  }
  return result;
}

function resolve(tree, source, specifier) {
  const name = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const candidates = [name];
  // TypeScript source commonly uses its emitted JS extension in imports.
  const replacement = {'.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts']}[path.posix.extname(name)];
  if (replacement) candidates.push(...replacement.map(extension => name.slice(0, -path.posix.extname(name).length) + extension));
  if (!path.posix.extname(name)) {
    for (const suffix of ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.cts', '.cjs', '.json']) candidates.push(name + suffix, name + '/index' + suffix);
  }
  const found = candidates.find(candidate => tree.has(candidate));
  if (!found || !found.startsWith(runtime)) throw Error(`Cannot ship runtime dependency ${specifier} from ${source}; keep its source inside foundation/runtime`);
  return found;
}

export function completeRuntimeCopies(plans, {tree, read, local, upstream, revision, checkTarget}) {
  const queue = plans.flatMap(plan => plan.sources.filter(([source]) => source.startsWith(runtime) && code.test(source))
    .map(([source]) => ({source, target: mapped(source, plan.copy.originPath, plan.copy.path), baseline: plan.copy.revision})));
  const seen = new Set();
  const blobs = new Map();
  function bytes(source) {
    const object = tree.get(source).object;
    if (!blobs.has(object)) blobs.set(object, read.blobs([object]).get(object));
    return blobs.get(object).toString('utf8');
  }
  function include(source, target, baseline) {
    checkTarget(target);
    let plan = plans.find(plan => inside(target, plan.copy.path));
    if (plan && mapped(target, plan.copy.path, plan.copy.originPath) !== source) throw Error(`Runtime dependency ${target} conflicts with its Base copy mapping`);
    // A missing recorded file is a removal, not an omitted sibling. Restoring
    // it here would bypass refresh's retirement/removal plan and could leave
    // the recreated source outside its record. Refuse before any writes.
    if (plan?.removed.includes(target)) throw Error(`Runtime dependency ${target} was removed locally but is still imported; no files were refreshed. Restore it or adapt the importing module before refreshing.`);
    if (plan?.copy.adapted?.[target]) {
      queue.push({source, target, baseline});
      return; // Keep seed bytes while supplying the shipped module's dependencies.
    }
    if (!plan?.sources.some(([name]) => name === source)) {
      const actual = local(target);
      const previous = actual && read.tree(baseline).get(source);
      const previousDigest = previous && read.digests([previous.object]).get(previous.object);
      if (actual && actual !== upstream.get(tree.get(source).object) && actual !== previousDigest) {
        // Existing unrecorded siblings belong to the seed, just as in the
        // ordinary copy selection. They already satisfy this import's presence;
        // only an absent sibling needs to be supplied by Base. Keep traversing
        // the shipped graph so a later adoption cannot omit its dependencies.
        // Recorded edits and acknowledgements were checked before planning.
        queue.push({source, target, baseline});
        return;
      }
      if (!plan) {
        if (plans.some(plan => inside(plan.copy.path, target))) throw Error(`Runtime dependency ${target} overlaps an existing Base copy`);
        plan = {copy: {path: target, originPath: source, revision, files: {}, modes: {}}, sources: [], removed: []};
        plans.push(plan);
      }
      plan.sources.push([source, tree.get(source)]);
      plan.removed = plan.removed.filter(name => name !== target);
    }
    queue.push({source, target, baseline});
  }
  for (let i = 0; i < queue.length; i++) {
    const {source, target, baseline} = queue[i];
    const key = source + '\0' + target;
    if (seen.has(key)) continue;
    seen.add(key);
    if (code.test(source)) for (const specifier of specifiers(bytes(source))) {
      const dependency = resolve(tree, source, specifier);
      include(dependency, path.posix.join(path.posix.dirname(target), path.posix.relative(path.posix.dirname(source), dependency)), baseline);
    }
    // JS type imports also need the declaration file used by edition typechecks.
    const declaration = source.replace(/\.mjs$/, '.d.mts').replace(/\.cjs$/, '.d.cts');
    if (declaration !== source && tree.has(declaration)) include(declaration, target.replace(/\.mjs$/, '.d.mts').replace(/\.cjs$/, '.d.cts'), baseline);
  }
}
