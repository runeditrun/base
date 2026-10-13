import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { cssReferences } from './site-markup.mjs';
import { memberName, stringValue, walkSyntax } from './site-syntax.mjs';

// CSS imports/assets and import.meta URL assets bypass Rollup's load hook in
// Vite. Inspect their syntax and recursively validate CSS before Vite reads it.
export function assetInputGuard(root, validate, deny, vite, compiled = false) {
 const inspected = new Set();
 return async function inspect(code, id) {
  // Vite loads this helper after rewriting dynamic imports. Its URL receives
  // emitted chunk names at runtime, not source assets; Vite's own asset URL
  // transform excludes the same exact helper. Resolve/load validation still
  // runs, and every other virtual module keeps the source-asset checks below.
  if (id === '\0vite/preload-helper.js') return null;
  const path = id.replace(/[?#].*$/, ''), css = /\.(?:css|scss|sass|less|styl|sss)$/.test(path), targets = [];
  if (css) targets.push(...cssReferences(code));
  else if (compiled || /\.[cm]?[jt]sx?$/.test(path) || id.startsWith('\0')) {
   const extension = !compiled && /\.(tsx?|jsx)$/.exec(path)?.[1];
   const source = extension ? (await vite.transformWithEsbuild(code, path, {loader:extension, tsconfigRaw:{}, sourcemap:false}, undefined, undefined, undefined, true)).code : code;
   walkSyntax(vite.parseAst(source), node => {
    if (node.type !== 'NewExpression' || node.callee.name !== 'URL') return;
    const base = node.arguments[1];
    if (memberName(base) !== 'url' || base.object.type !== 'MetaProperty' || base.object.meta.name !== 'import') return;
    const url = stringValue(node.arguments[0]);
    const template = node.arguments[0];
    const prefix = template?.type === 'TemplateLiteral' ? template.quasis[0].value.cooked : null;
    targets.push({url, dynamic:url === undefined, prefix});
   });
  }
  for (const target of targets) {
   if (target.dynamic) {
    // Vite expands a relative template to glob imports. Validate the static
    // directory now; resolve/load validate every glob result before loading.
    if (!target.prefix?.startsWith('./') && !target.prefix?.startsWith('../')) { await deny('site_private_input'); continue; }
    const directory = target.prefix.endsWith('/') ? target.prefix : dirname(target.prefix);
    await validate(resolve(dirname(path), directory), id);
    continue;
   }
   const url = target.url;
   if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue;
   // Match Vite's public-directory handling as well as package/alias resolution.
   const publicFile = url.startsWith('/') ? resolve(root, 'public', url.slice(1)) : null;
   const publicExists = publicFile && await readFileStatus(publicFile);
   const result = publicExists ? {id:publicFile} : await this.resolve(url, id);
   const file = result?.id ?? resolve(dirname(path), url);
   await validate(file, id);
   const resolved = file.replace(/[?#].*$/, '');
   if (css && isAbsolute(resolved) && /\.(?:css|scss|sass|less|styl|sss)$/.test(resolved) && !inspected.has(resolved)) {
    inspected.add(resolved);
    const nested = await readFile(resolved, 'utf8');
    await inspect.call(this, nested, resolved);
   }
  }
  return null;
 };
}
const readFileStatus = path => stat(path.replace(/[?#].*$/, '')).then(value => value.isFile(), () => false);
