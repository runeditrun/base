import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonc } from '../../cli/jsonc.mjs';
import { tomlMain } from '../../cli/deploy-config.mjs';

const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const builtExtensions = ['.mjs', '.js', '.cjs', '.jsx'];

const normalized = path => resolve(path);
const displayPath = (root, path) => relative(root, path).split(sep).join('/') || '.';
const isDeclaration = path => /\.d\.(?:ts|mts|cts)$/i.test(path);
const isCode = path => sourceExtensions.has(extname(path).toLowerCase()) && !isDeclaration(path);
const isPackagePath = path => path.split(sep).includes('node_modules');
const stripQuery = specifier => specifier.split(/[?#]/, 1)[0];
const isRelative = specifier => specifier.startsWith('./') || specifier.startsWith('../');
const isScheme = specifier => /^[a-z][a-z\d+.-]*:/i.test(specifier);

function runtimeImport(ts, declaration) {
 const clause = declaration.importClause;
 if (!clause) return true;
 if (clause.isTypeOnly) return false;
 if (clause.name) return true;
 const bindings = clause.namedBindings;
 if (!bindings || ts.isNamespaceImport(bindings)) return Boolean(bindings);
 return bindings.elements.length === 0 || bindings.elements.some(element => !element.isTypeOnly);
}

function runtimeReexport(ts, declaration) {
 if (declaration.isTypeOnly) return false;
 const clause = declaration.exportClause;
 return !clause || !ts.isNamedExports(clause) || clause.elements.length === 0 || clause.elements.some(element => !element.isTypeOnly);
}

function runtimeEdges(ts, tree) {
 const edges = [];
 const add = (node, kind) => {
  if (node && ts.isStringLiteralLike(node)) edges.push({ specifier: node.text, kind });
 };
 function visit(node) {
  if (ts.isImportDeclaration(node) && runtimeImport(ts, node)) add(node.moduleSpecifier, 'import');
  else if (ts.isExportDeclaration(node) && node.moduleSpecifier && runtimeReexport(ts, node)) add(node.moduleSpecifier, 're-export');
  else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, 'import-equals');
  else if (ts.isCallExpression(node)) {
   if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'dynamic-import');
   else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], 'require');
  }
  ts.forEachChild(node, visit);
 }
 visit(tree);
 return edges;
}

function matchesPathAlias(specifier, options) {
 for (const pattern of Object.keys(options.paths ?? {})) {
  const wildcard = pattern.indexOf('*');
  if (wildcard < 0 ? specifier === pattern : specifier.startsWith(pattern.slice(0, wildcard)) && specifier.endsWith(pattern.slice(wildcard + 1))) return true;
 }
 return false;
}

async function localAssetExists(from, specifier) {
 const target = resolve(dirname(from), stripQuery(specifier));
 try { return (await stat(target)).isFile() ? target : null; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

async function loadTypeScript(root) {
 const require = createRequire(join(root, 'package.json'));
 const path = require.resolve('typescript');
 return import(pathToFileURL(path));
}

async function compilerOptions(root, ts) {
 const path = join(root, 'tsconfig.json');
 if (!ts.sys.fileExists(path)) return { allowJs: true, resolveJsonModule: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
 try {
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, {
   ...ts.sys,
   onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
   },
  });
  if (!parsed) throw new Error('TypeScript did not return parsed compiler options');
  const errors = parsed.errors.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
  return { ...parsed.options, allowJs: true, resolveJsonModule: true };
 } catch (error) {
  if (error.code === 'ENOENT') return { allowJs: true, resolveJsonModule: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  throw new Error(`Could not read TypeScript project configuration: ${error.message}`, { cause: error });
 }
}

async function configuredEntry(root) {
 for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
  let text;
  try { text = await readFile(join(root, name), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  let main;
  try {
   main = name.endsWith('.toml') ? tomlMain(text) : parseJsonc(text).main;
  } catch (error) {
   throw new Error(`Could not read Wrangler main from ${name}: ${error.message}`, { cause: error });
  }
  if (typeof main !== 'string' || !main.trim()) throw new Error(`${name} does not declare a Wrangler main entry`);
  return resolve(root, main);
 }
 throw new Error('No root wrangler.jsonc, wrangler.json, or wrangler.toml declares the app main entry');
}

function failure(path, api, extra = {}) {
 return { path, api, ...extra };
}

async function resolveSourceEdge(ts, specifier, importer, options) {
 const request = stripQuery(specifier);
 const local = isRelative(request) || isAbsolute(request) || matchesPathAlias(request, options);
 if (isScheme(request)) return { external: true };
 const javascriptRequest = builtExtensions.includes(extname(request).toLowerCase());
 if (javascriptRequest && (isRelative(request) || isAbsolute(request))) {
  const implementation = await localAssetExists(importer, request);
  if (implementation) return isPackagePath(implementation) ? { external: true } : { path: implementation };
 }
 // TypeScript prefers declaration sidecars to JavaScript implementations. They
 // describe types, not the code the runtime will execute, so exclude them from
 // graph resolution. Explicit JavaScript imports first try real JavaScript;
 // the second pass retains TypeScript's extension substitution for source apps
 // that import ./module.js but author module.ts (including configured aliases).
 const implementationHost = { ...ts.sys, fileExists: path => !isDeclaration(path) && ts.sys.fileExists(path) };
 const javascriptHost = { ...ts.sys, fileExists: path => !/\.(?:ts|tsx|mts|cts)$/i.test(path) && ts.sys.fileExists(path) };
 const resolved = (javascriptRequest && ts.resolveModuleName(request, importer, options, javascriptHost).resolvedModule)
  || ts.resolveModuleName(request, importer, options, implementationHost).resolvedModule;
 if (resolved) {
  const path = normalized(resolved.resolvedFileName);
  if (resolved.isExternalLibraryImport || isPackagePath(path)) return { external: true };
  if (isCode(path)) return { path };
  return { external: true };
 }
 if (!local) return { external: true };
 const asset = await localAssetExists(importer, specifier);
 if (asset && !isCode(asset) && !isDeclaration(asset)) return { external: true };
 return { unresolved: true };
}

async function builtCandidates(importer, request) {
 const target = resolve(dirname(importer), request);
 if (extname(target)) return [target];
 return [...builtExtensions.map(extension => target + extension), ...builtExtensions.map(extension => join(target, 'index' + extension))];
}

async function resolveBuiltEdge(importer, specifier, emittedFiles, outputRoot) {
 const request = stripQuery(specifier);
 if (isScheme(request) || (!isRelative(request) && !isAbsolute(request))) return { external: true };
 const requested = resolve(dirname(importer), request);
 const candidates = await builtCandidates(importer, request);
 for (const candidate of candidates) {
  try {
   if (!(await stat(candidate)).isFile()) continue;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
  if (!isCode(candidate)) return { external: true };
  const path = normalized(candidate), rel = relative(outputRoot, path);
  if (rel.startsWith('..') || isAbsolute(rel)) return { unresolved: true, reason: 'local import escapes the built server output' };
  if (!emittedFiles.has(path)) return { unresolved: true, reason: 'local import was not emitted by this build' };
  return { path };
 }
 if (extname(requested) && !sourceExtensions.has(extname(requested).toLowerCase())) {
  const asset = await localAssetExists(importer, specifier);
  if (asset) return { external: true };
 }
 return { unresolved: true };
}

export async function walkImportGraph(root, { entries, emittedFiles, outputRoot, onFile }) {
 const ts = await loadTypeScript(root), options = await compilerOptions(root, ts);
 const failures = [], visited = new Set(), pending = (await Promise.all(entries.map(async entry => {
  if (isAbsolute(entry)) return normalized(entry);
  return resolve(root, entry);
 }))).reverse();
 const emitted = emittedFiles ? new Set([...emittedFiles].map(normalized)) : null;
 const builtRoot = outputRoot ? normalized(outputRoot) : null;
 const built = Boolean(emitted && builtRoot);

 while (pending.length) {
  const path = pending.pop(), canonical = normalized(path);
  if (visited.has(canonical)) continue;
  visited.add(canonical);
  let source;
  try { source = await readFile(canonical, 'utf8'); }
  catch (error) { failures.push(failure(displayPath(root, canonical), 'Missing app entry or runtime module', { message: error.message })); continue; }
  if (!isCode(canonical)) { failures.push(failure(displayPath(root, canonical), 'App graph entry is not a JavaScript or TypeScript module')); continue; }
  const tree = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, true);
  onFile?.({ ts, tree, path: canonical, source });
  for (const edge of runtimeEdges(ts, tree)) {
   const result = built
    ? await resolveBuiltEdge(canonical, edge.specifier, emitted, builtRoot)
    : await resolveSourceEdge(ts, edge.specifier, canonical, options);
   if (result.unresolved) {
    failures.push(failure(displayPath(root, canonical), 'Unresolved local runtime import', { specifier: edge.specifier, kind: edge.kind, ...(result.reason ? { message: result.reason } : {}) }));
   } else if (result.path) pending.push(result.path);
  }
 }
 return { ts, files: visited, failures };
}

export { configuredEntry, isCode };
