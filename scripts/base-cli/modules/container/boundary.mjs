import { relative, sep } from 'node:path';
import { configuredEntry, walkImportGraph } from './import-graph.mjs';

export async function checkBoundary(root, { engine='node', cacheContract, entries, emittedFiles, outputRoot }={}) {
 const failures = [];
 if (Boolean(emittedFiles) !== Boolean(outputRoot)) throw new Error('Emitted files and output root must be supplied together');
 const roots = entries ?? [await configuredEntry(root)];
 if (!Array.isArray(roots) || !roots.length) throw new Error('At least one app entry is required');
 const graph = await walkImportGraph(root, {
  entries: roots,
  emittedFiles,
  outputRoot,
  onFile({ ts, tree, path }) {
   const name = relative(root, path).split(sep).join('/');
   const cache = cacheContract === 'lamp-retained-v1' && /(?:^|\/)platform\/blobs\/snapshot-cache\.ts$/.test(name);
   const bindings = /(?:^|\/)platform\/bindings\.server\.ts$/.test(name);
   // The demo guard an exported seed carries reads RER_DEMO from env: that one
   // file, and only its unrenamed `env` import.
   const demo = name === 'src/modules/demo/index.mjs';
   const fail = api => failures.push({ path:name, api }), localNames = new Set();
   function collectNames(node) {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isImportSpecifier(node)) && node.name && ts.isIdentifier(node.name)) localNames.add(node.name.text);
    ts.forEachChild(node, collectNames);
   }
   collectNames(tree);
   function visit(node) {
   const runtimeDeclaration = declaration => {
    if (ts.isImportDeclaration(declaration)) {
     const clause = declaration.importClause;
     if (!clause) return true;
     if (clause.isTypeOnly) return false;
     if (clause.name) return true;
     const bindings = clause.namedBindings;
     return !bindings || ts.isNamespaceImport(bindings) || bindings.elements.length === 0 || bindings.elements.some(element => !element.isTypeOnly);
    }
    if (ts.isExportDeclaration(declaration)) {
     if (declaration.isTypeOnly) return false;
     const clause = declaration.exportClause;
     return !clause || !ts.isNamedExports(clause) || clause.elements.length === 0 || clause.elements.some(element => !element.isTypeOnly);
    }
    return false;
   };
   if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && runtimeDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
     const module = node.moduleSpecifier.text;
     if (module.startsWith('cloudflare:')) {
      const imports = node.importClause?.namedBindings;
      const runtimeImports = imports && ts.isNamedImports(imports) ? imports.elements.filter(element => !element.isTypeOnly) : [];
      const allowed = module === 'cloudflare:workers' && runtimeImports.length > 0 && imports && ts.isNamedImports(imports) && runtimeImports.every(element =>
       (demo && !node.importClause.name && !element.propertyName && element.name.text === 'env') ||
       (bindings && (element.propertyName ?? element.name).text === 'env') ||
       (cache && (element.propertyName ?? element.name).text === 'DurableObject'));
      if (!allowed && !(engine === 'workerd' && module === 'cloudflare:workers')) fail('Cloudflare import outside binding/cache contract');
     }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression) && node.moduleReference.expression.text.startsWith('cloudflare:')) fail('Dynamic Cloudflare import');
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
     const module = node.arguments[0].text;
     const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
     const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
     if ((isDynamicImport || isRequire) && module.startsWith('cloudflare:') && !(engine === 'workerd' && isDynamicImport && module === 'cloudflare:workers')) fail('Dynamic Cloudflare import');
    }
    if (ts.isIdentifier(node) && engine !== 'workerd' && ['WebSocketPair','passThroughOnException','timingSafeEqual','HTMLRewriter'].includes(node.text)) fail(node.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'email' && !localNames.has('email')) fail('email()');
    if (ts.isPropertyAccessExpression(node) && ((node.expression.getText(tree) === 'caches' && node.name.text === 'default') || (node.expression.getText(tree) === 'request' && node.name.text === 'cf'))) fail(node.getText(tree));
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && ((node.expression.getText(tree) === 'caches' && node.argumentExpression.text === 'default') || (node.expression.getText(tree) === 'request' && node.argumentExpression.text === 'cf'))) fail(node.getText(tree));
    if (engine !== 'workerd' && ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword && node.types.some(type => /DurableObject/.test(type.expression.getText(tree))) && !cache) fail('New Durable Object');
    ts.forEachChild(node, visit);
   }
   visit(tree);
  },
 });
 failures.push(...graph.failures);
 if (failures.length) { const cause = new Error('Container import boundary failed'); cause.failures = failures; throw cause; }
 return { engine, ok:true };
}

export { configuredEntry };
