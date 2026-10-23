import ts from '../default-seed/node_modules/typescript/lib/typescript.js';
import {testSource} from '../composition/git-source.mjs';

const production = name => name.startsWith('modules/') &&
  !testSource(name) && !/\.d\.[cm]?ts$/.test(name);
const source = name => production(name) && /\.[cm]?[jt]s$/.test(name);
const sqlStatement = /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*(?:CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+|DELETE\s+FROM|SELECT\s+|PRAGMA\s+)\b/i;
const ddlStatement = /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*(?:CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE|VIRTUAL)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW))\s/i;

// Keep the SQL expression's bindings, rather than every runtime dependency of
// an installer. A prepare/exec call's database receiver is not part of its SQL.
function sqlExpression(node) {
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    while (!ts.isTemplateExpression(node)) node = node.parent;
  }
  while (ts.isParenthesizedExpression(node.parent) || ts.isBinaryExpression(node.parent) ||
    ts.isConditionalExpression(node.parent) || ts.isTaggedTemplateExpression(node.parent)) node = node.parent;
  return node;
}

// Analyze the released tree, never today's imports. A removed export/import
// cannot erase protection. No released module is executed during discovery.
export function migrationInputs(files) {
  const origins = new Set([...files.keys()].filter(name =>
    (name.startsWith('modules/') || name.startsWith('foundation/runtime/')) && name.endsWith('.sql')));
  const sources = new Map([...files].filter(([name]) => source(name)).map(([name, bytes]) =>
    ['/' + name, ts.createSourceFile('/' + name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)]));
  const host = {
    getSourceFile: name => sources.get(name),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile() {}, getCurrentDirectory: () => '/', getDirectories: () => [],
    fileExists: name => sources.has(name), readFile: name => sources.get(name)?.text,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([...sources.keys()], {
    noLib: true, allowJs: true, allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  }, host);
  const checker = program.getTypeChecker(), declarations = new Map();
  const symbolAt = node => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  for (const file of sources.values()) {
    if (file.parseDiagnostics.length) throw Error(`Cannot parse released migration input: ${file.fileName.slice(1)}`);
    for (const statement of file.statements) {
      const exported = statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword);
      const nodes = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
      for (const node of nodes) {
        if (!node.name || !ts.isIdentifier(node.name)) continue;
        const body = ts.isVariableDeclaration(node) ? node.initializer : node;
        if (!body) continue;
        declarations.set(symbolAt(node.name), {file, body, dependencies: new Set(), sql: false, ddl: [],
          value: ts.isVariableDeclaration(node) && !ts.isArrowFunction(body) && !ts.isFunctionExpression(body),
          // Retain the original documented migration-array class as well.
          migration: !!exported && ts.isArrayLiteralExpression(body) && /(?:Migration|Schema)$/.test(node.name.text)});
      }
    }
  }
  for (const declaration of declarations.values()) {
    const visit = node => {
      if (ts.isTypeNode(node)) return;
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (sqlStatement.test(node.text)) declaration.sql = true;
        if (ddlStatement.test(node.text)) declaration.ddl.push(sqlExpression(node));
      }
      if (ts.isIdentifier(node)) {
        const dependency = declarations.get(symbolAt(node));
        if (dependency && dependency !== declaration) declaration.dependencies.add(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  // Propagate SQL provenance through exported values, including aggregations
  // that contain no SQL literal of their own (arrays, spreads and helper calls).
  const sql = new Set([...declarations.values()].filter(item => item.sql));
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of declarations.values()) if (!sql.has(item) && [...item.dependencies].some(dep => sql.has(dep))) {
      sql.add(item); grew = true;
    }
  }
  const visited = new Set();
  const binding = (node, file) => {
    const dependency = declarations.get(symbolAt(node));
    if (dependency) return dependency;
    const local = checker.getSymbolAtLocation(node);
    for (const decl of local?.declarations ?? []) {
      if (!ts.isImportSpecifier(decl) && !ts.isImportClause(decl) && !ts.isNamespaceImport(decl)) continue;
      let statement = decl;
      while (statement && !ts.isImportDeclaration(statement)) statement = statement.parent;
      if (!statement || statement.importClause?.isTypeOnly || decl.isTypeOnly) continue;
      throw Error(`Unresolved migration dependency ${statement.moduleSpecifier.text} in ${file.fileName.slice(1)}`);
    }
  };
  const protect = item => {
    if (visited.has(item)) return;
    visited.add(item); origins.add(item.file.fileName.slice(1));
    for (const dependency of item.dependencies) protect(dependency);
    // Value imports must resolve inside the released graph. External helpers
    // cannot silently participate in a supposedly immutable schema value.
    const visit = node => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) binding(node, item.file);
      ts.forEachChild(node, visit);
    };
    visit(item.body);
  };
  for (const item of declarations.values()) if (item.migration) protect(item);
  const reachable = new Set();
  const follow = item => {
    if (reachable.has(item)) return;
    reachable.add(item);
    for (const dependency of item.dependencies) follow(dependency);
  };
  for (const file of sources.values()) {
    const module = checker.getSymbolAtLocation(file);
    for (const exported of module ? checker.getExportsOfModule(module) : []) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const item = declarations.get(symbol);
      if (item) follow(item);
      if (item?.value && sql.has(item)) {
        // A barrel's export binding also determines which SQL consumers get.
        origins.add(file.fileName.slice(1)); protect(item);
      }
    }
  }
  // Runtime installers are roots too. Freeze DDL-bearing files reached from
  // exported declarations, including private/imported functions and arrows.
  // SELECT/INSERT-only handlers do not become roots of schema protection.
  for (const item of reachable) for (const expression of item.ddl) {
    origins.add(item.file.fileName.slice(1));
    const visit = node => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) {
        const dependency = binding(node, item.file);
        if (dependency && dependency !== item) protect(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
  }
  return origins;
}
