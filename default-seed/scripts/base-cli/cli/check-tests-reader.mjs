import { readFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const unknown = Symbol('unresolved');
const registrar = Object.freeze({ kind: 'registrar' });
const suite = Object.freeze({ kind: 'suite' });
const context = Object.freeze({ test: registrar });
const dynamicRegistration = Object.freeze({ kind: 'dynamic-registration' });
const assertion = Object.freeze({ kind: 'assertion' });

// This is a bounded syntax reader. Its values are literals and registration
// symbols; it never evaluates project JavaScript or imports a project module.
export function registrationReader(ts, { root, platform, excluded, limit }) {
 const modules = new Map(), diagnostics = new Set(), contributions = new Map(), active = new Set();
 let steps = 0;
 const name = file => relative(root, file).split(sep).join('/');
 const diagnostic = (node, message) => {
  const source = node.getSourceFile();
  diagnostics.add(`${name(source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
 };
 const tick = node => { if (++steps > 250000) { diagnostic(node, 'Registration analysis exceeds the bounded reader limit.'); throw Error('Registration analysis exceeds the bounded reader limit.'); } };
 const builtin = specifier => {
  if (['node:test', 'test'].includes(specifier)) return { default: registrar, test: registrar, it: registrar, describe: suite, suite };
  if (['@playwright/test', 'vitest', '@jest/globals'].includes(specifier)) return { default: registrar, test: registrar, it: registrar, describe: suite };
  if (/^(?:node:)?assert(?:\/strict)?$/.test(specifier)) return { default: assertion, strict: assertion, ok: assertion, equal: assertion, deepEqual: assertion };
  if (['node:os', 'os'].includes(specifier)) return { platform: { kind: 'platform' } };
  return undefined;
 };
 const isFunction = value => value?.kind === 'function';
 function syntaxHasRegistration(node) {
  if (!node) return false;
  if (ts.isCallExpression(node)) {
   const text = node.expression.getText();
   if (/^(?:(?:test|it|contract|describe|suite)(?:\.(?:skip|only|todo|each))?|t\.test)$/.test(text)) return true;
  }
  let found = false; ts.forEachChild(node, child => { if (syntaxHasRegistration(child)) found = true; }); return found;
 }
 function bind(pattern, value, env) {
  if (ts.isIdentifier(pattern)) env.set(pattern.text, value);
  else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
   pattern.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return;
    const key = element.propertyName?.text ?? element.name?.text ?? index;
    let selected = value === unknown || value == null ? unknown : value[ts.isArrayBindingPattern(pattern) ? index : key];
    if ((selected === unknown || selected === undefined) && element.initializer) selected = valueOf(element.initializer, env);
    bind(element.name, selected, env);
   });
  }
 }
 function property(value, key) {
  if (value === dynamicRegistration || (value === registrar && key === unknown)) return dynamicRegistration;
  if (value === unknown || key === unknown || value == null) return unknown;
  if (value === registrar && ['skip', 'only', 'todo', 'concurrent', 'serial', 'failing'].includes(key)) return registrar;
  if ((value === registrar || value === suite) && key === 'each') return { kind: 'each', base: value };
  if (value === registrar) return dynamicRegistration;
  if (value === assertion) return assertion;
  if (value?.kind === 'namespace') return value.module.exports.get(key) ?? unknown;
  if (typeof value === 'object' && !Array.isArray(value) && !value.kind) return value[key];
  if (typeof value === 'object' && Object.hasOwn(value, key)) return value[key];
  if (key === 'length' && (Array.isArray(value) || typeof value === 'string')) return value.length;
  if (Array.isArray(value) && ['entries', 'keys', 'values', 'map', 'flatMap', 'filter', 'forEach'].includes(key)) return { kind: 'array-method', value, method: key };
  return unknown;
 }
 function valueOf(node, env) {
  if (!node) return unknown;
  tick(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) return valueOf(node.expression, env);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) return env.has(node.text) ? env.get(node.text) : unknown;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return { kind: 'function', node, env };
  if (ts.isArrayLiteralExpression(node)) {
   const result = [];
   for (const element of node.elements) {
    if (ts.isSpreadElement(element)) { const value = valueOf(element.expression, env); if (!Array.isArray(value)) return unknown; result.push(...value); }
    else result.push(valueOf(element, env));
   }
   return result;
  }
  if (ts.isObjectLiteralExpression(node)) {
   const result = {};
   for (const member of node.properties) {
    if (ts.isSpreadAssignment(member)) { const value = valueOf(member.expression, env); if (value !== unknown && value && typeof value === 'object') Object.assign(result, value); }
    else if (ts.isPropertyAssignment(member)) result[member.name.text] = valueOf(member.initializer, env);
    else if (ts.isShorthandPropertyAssignment(member)) result[member.name.text] = env.has(member.name.text) ? env.get(member.name.text) : unknown;
    else if (ts.isMethodDeclaration(member)) result[member.name.text] = { kind: 'function', node: member, env };
   }
   return result;
  }
  if (ts.isPropertyAccessExpression(node)) return property(valueOf(node.expression, env), node.name.text);
  if (ts.isElementAccessExpression(node)) return property(valueOf(node.expression, env), valueOf(node.argumentExpression, env));
  if (ts.isTemplateExpression(node)) {
   let result = node.head.text;
   for (const part of node.templateSpans) { const value = valueOf(part.expression, env); if (value === unknown || typeof value === 'object') return unknown; result += String(value) + part.literal.text; }
   return result;
  }
  if (ts.isPrefixUnaryExpression(node)) {
   const value = valueOf(node.operand, env); if (value === unknown) return unknown;
   if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
   if (node.operator === ts.SyntaxKind.MinusToken) return -value;
   if (node.operator === ts.SyntaxKind.PlusToken) return +value;
  }
  if (ts.isConditionalExpression(node)) {
   const condition = valueOf(node.condition, env);
   if (condition === unknown) {
    const yes = valueOf(node.whenTrue, env), no = valueOf(node.whenFalse, env);
    if (yes === no) return yes;
    return [yes, no].some(value => value === registrar || value === dynamicRegistration || isFunction(value) && potential(value)) ? dynamicRegistration : unknown;
   }
   return valueOf(condition ? node.whenTrue : node.whenFalse, env);
  }
  if (ts.isBinaryExpression(node)) {
   const left = valueOf(node.left, env), op = node.operatorToken.kind;
   if (op === ts.SyntaxKind.AmpersandAmpersandToken && left !== unknown) return left ? valueOf(node.right, env) : left;
   if (op === ts.SyntaxKind.BarBarToken && left !== unknown) return left ? left : valueOf(node.right, env);
   if (op === ts.SyntaxKind.QuestionQuestionToken && left !== unknown) return left == null ? valueOf(node.right, env) : left;
   const right = valueOf(node.right, env);
   if (left === unknown || right === unknown) return unknown;
   switch (op) {
    case ts.SyntaxKind.PlusToken: return left + right;
    case ts.SyntaxKind.MinusToken: return left - right;
    case ts.SyntaxKind.AsteriskToken: return left * right;
    case ts.SyntaxKind.LessThanToken: return left < right;
    case ts.SyntaxKind.LessThanEqualsToken: return left <= right;
    case ts.SyntaxKind.GreaterThanToken: return left > right;
    case ts.SyntaxKind.GreaterThanEqualsToken: return left >= right;
    case ts.SyntaxKind.EqualsEqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsToken: return left === right;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: case ts.SyntaxKind.ExclamationEqualsToken: return left !== right;
    default: return unknown;
   }
  }
  if (ts.isNewExpression(node) && node.expression.getText() === 'Set') {
   const values = valueOf(node.arguments?.[0], env);
   return Array.isArray(values) ? [...new Set(values)] : unknown;
  }
  if (ts.isCallExpression(node)) {
   if (ts.isPropertyAccessExpression(node.expression)) {
    const receiver = node.expression.expression.getText(), method = node.expression.name.text;
    const args = node.arguments.map(argument => valueOf(argument, env));
    if (receiver === 'Object' && ['freeze', 'seal'].includes(method)) return args[0];
    if (receiver === 'Object' && ['entries', 'keys', 'values'].includes(method) && args[0] !== unknown && args[0] != null) return Object[method](args[0]);
    if (method === 'join') { const values = valueOf(node.expression.expression, env); if (Array.isArray(values) && values.every(value => value !== unknown)) return values.join(args[0] === unknown ? ',' : args[0]); }
   }
   const callable = valueOf(node.expression, env);
   if (callable === dynamicRegistration) return dynamicRegistration;
   if (callable?.kind === 'platform') return platform;
   if (callable?.kind === 'each') return { kind: 'cases', base: callable.base, cases: valueOf(node.arguments[0], env) };
   if (callable?.kind === 'array-method') {
    const { value, method } = callable;
    if (method === 'entries') return value.map((item, index) => [index, item]);
    if (method === 'keys') return value.map((_, index) => index);
    if (method === 'values') return value;
   }
   return unknown;
  }
  return unknown;
 }
 async function load(file) {
  file = resolve(file);
  if (excluded.has(file) || file.split(sep).includes('node_modules')) return;
  if (modules.has(file)) return modules.get(file);
  if (modules.size >= limit) throw Error('Test import graph exceeds the bounded reader limit.');
  let text;
  try { const info = await lstat(file); if (!info.isFile()) return; if (info.size > 2_000_000) throw Error('oversized'); text = await readFile(file, 'utf8'); }
  catch (error) { if (error.message === 'oversized') throw Error(`Registration source ${name(file)} exceeds the bounded reader size limit.`); if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const module = { source, env: new Map([['process', { platform, env: unknown }], ['undefined', undefined]]), exports: new Map(), imports: [], evaluated: false, asserts: false };
  modules.set(file, module);
  for (const statement of source.statements) {
   if (ts.isImportDeclaration(statement)) {
    const specifier = statement.moduleSpecifier.text;
    let imported = builtin(specifier), target;
    if (!imported && specifier.startsWith('.')) {
     const path = resolve(dirname(file), specifier);
     for (const candidate of [path, path.replace(/\.js$/, '.ts'), path + '.mjs', path + '.ts', join(path, 'index.mjs')]) { target = await load(candidate); if (target) break; }
     if (target) module.imports.push(target);
    }
    const clause = statement.importClause;
    if (!clause) continue;
    const get = key => imported?.[key] ?? target?.exports.get(key) ?? unknown;
    if (clause.name) module.env.set(clause.name.text, get('default'));
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) module.env.set(clause.namedBindings.name.text, target ? { kind: 'namespace', module: target } : imported ?? unknown);
    else for (const binding of clause.namedBindings?.elements ?? []) module.env.set(binding.name.text, get(binding.propertyName?.text ?? binding.name.text));
    if (/^(?:node:)?assert(?:\/strict)?$/.test(specifier)) module.asserts = true;
   }
   if (ts.isFunctionDeclaration(statement) && statement.name) {
    const fn = valueOf(statement, module.env); module.env.set(statement.name.text, fn);
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) module.exports.set(statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name.text, fn);
   }
   if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    bind(declaration.name, valueOf(declaration.initializer, module.env), module.env);
    if (ts.isIdentifier(declaration.name) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) module.exports.set(declaration.name.text, module.env.get(declaration.name.text));
   }
   if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    let target;
    if (statement.moduleSpecifier) target = await load(resolve(dirname(file), statement.moduleSpecifier.text));
    for (const element of statement.exportClause.elements) module.exports.set(element.name.text, target?.exports.get(element.propertyName?.text ?? element.name.text) ?? module.env.get(element.propertyName?.text ?? element.name.text) ?? unknown);
   }
   if (ts.isExportAssignment(statement)) module.exports.set('default', valueOf(statement.expression, module.env));
  }
  return module;
 }
 const potentialCache = new Map();
 function potential(fn, seen = new Set()) {
  if (potentialCache.has(fn.node)) return potentialCache.get(fn.node);
  if (seen.has(fn.node)) return false;
  const next = new Set(seen).add(fn.node);
  let found = syntaxHasRegistration(fn.node.body);
  function visit(node) {
   if (found) return;
   if (ts.isCallExpression(node)) {
    const callable = valueOf(node.expression, fn.env);
    if ([registrar, suite, dynamicRegistration].includes(callable) || callable?.kind === 'cases' ||
        (isFunction(callable) && potential(callable, next))) found = true;
   }
   if (!found) ts.forEachChild(node, visit);
  }
  if (!found) visit(fn.node.body);
  potentialCache.set(fn.node, found);
  return found;
 }
 function registrationValue(value) {
  if (value === registrar || value === suite || value === dynamicRegistration) return true;
  if (isFunction(value)) return potential(value);
  if (value && typeof value === 'object' && !value.kind) return Object.values(value).some(registrationValue);
  return false;
 }
 function canRegister(node, env) {
  if (!node) return false;
  let found = false;
  function visit(child) {
   if (found || ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child)) return;
   if (ts.isCallExpression(child)) {
    const callable = valueOf(child.expression, env);
    if ([registrar, suite, dynamicRegistration].includes(callable) || callable?.kind === 'cases' || callable?.kind === 'each' ||
        (isFunction(callable) && potential(callable)) ||
        child.arguments.some(argument => registrationValue(valueOf(argument, env))) ||
        (callable === unknown && /^(?:test|it|contract|t\.test)(?:\.|$)/.test(child.expression.getText()))) { found = true; return; }
   }
   ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
 }
 function add(owner) { contributions.set(owner, (contributions.get(owner) ?? 0) + 1); }
 async function invoke(fn, args, owner, site) {
  if (active.has(fn.node)) { diagnostic(site, 'Recursive registration wrapper is unresolved.'); return unknown; }
  const env = new Map(fn.env);
  fn.node.parameters.forEach((parameter, index) => bind(parameter.name, args[index] === undefined && parameter.initializer ? valueOf(parameter.initializer, env) : args[index] ?? unknown, env));
  active.add(fn.node);
  try {
   if (ts.isBlock(fn.node.body)) return await statements(fn.node.body.statements, env, owner);
   return await expression(fn.node.body, env, owner);
  } finally { active.delete(fn.node); }
 }
 async function expression(node, env, owner) {
  if (!node) return unknown;
  tick(node);
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return expression(node.expression, env, owner);
  if (ts.isCallExpression(node)) {
   const callable = valueOf(node.expression, env);
   if (callable === dynamicRegistration) { diagnostic(node, 'Unresolved dynamic registration alias.'); return unknown; }
   if (callable === registrar || callable === suite || callable?.kind === 'cases') {
    const cases = callable?.kind === 'cases' ? callable.cases : [null];
    if (!Array.isArray(cases)) { diagnostic(node, 'Unresolved dynamic .each registration cases.'); return unknown; }
    if (cases.length > limit) { diagnostic(node, 'Registration cases exceed the bounded reader limit.'); return unknown; }
    const base = callable?.kind === 'cases' ? callable.base : callable;
    const callback = [...node.arguments].reverse().map(argument => valueOf(argument, env)).find(isFunction);
    for (const row of cases) {
     if (base === registrar) add(owner);
     if (callback) {
      const args = callable?.kind === 'cases' ? (Array.isArray(row) ? row : [row]) : [context];
      // Read nested registrations, never evaluate assertions or fixture effects.
      await invoke(callback, args, owner, node);
     }
    }
    return unknown;
   }
   if (isFunction(callable) && canRegister(node, env)) return invoke(callable, node.arguments.map(argument => valueOf(argument, env)), owner, node);
   if (callable?.kind === 'array-method' && callable.method === 'forEach') {
    const callback = valueOf(node.arguments[0], env);
    if (isFunction(callback)) for (const [index, item] of callable.value.entries()) if (canRegister(callback.node.body, new Map([...callback.env, ...env]))) await invoke(callback, [item, index], owner, node);
    return unknown;
   }
   // An unknown higher-order call carrying registrations cannot silently vanish.
   if (node.arguments.some(argument => syntaxHasRegistration(argument) || registrationValue(valueOf(argument, env))) || (callable === unknown && /^(?:test|it|contract|t\.test)(?:\.|$)/.test(node.expression.getText()))) diagnostic(node, 'Unresolved dynamic registration or registration wrapper.');
   return valueOf(node, env);
  }
  if (ts.isConditionalExpression(node)) {
   const condition = valueOf(node.condition, env);
   if (condition === unknown) { if (canRegister(node, env)) diagnostic(node, 'Unresolved conditional registration; declare a supported static configuration.'); return valueOf(node, env); }
   return expression(condition ? node.whenTrue : node.whenFalse, env, owner);
  }
  if (ts.isBinaryExpression(node)) {
   const op = node.operatorToken.kind;
   if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) { const value = await expression(node.right, env, owner); env.set(node.left.text, value); return value; }
   if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(op)) {
    const left = valueOf(node.left, env);
    if (left === unknown) { if (canRegister(node.right, env)) diagnostic(node, 'Unresolved conditional registration.'); return unknown; }
    const right = op === ts.SyntaxKind.AmpersandAmpersandToken ? Boolean(left) : op === ts.SyntaxKind.BarBarToken ? !left : left == null;
    return right ? expression(node.right, env, owner) : left;
   }
  }
  return valueOf(node, env);
 }
 async function statements(nodes, env, owner) {
  for (const node of nodes) if (ts.isFunctionDeclaration(node) && node.name) env.set(node.name.text, valueOf(node, env));
  for (const node of nodes) {
   tick(node);
   if (ts.isFunctionDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) continue;
   if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) bind(declaration.name, await expression(declaration.initializer, env, owner), env);
   else if (ts.isExpressionStatement(node)) await expression(node.expression, env, owner);
   else if (ts.isReturnStatement(node)) return expression(node.expression, env, owner);
   else if (ts.isBlock(node)) await statements(node.statements, new Map(env), owner);
   else if (ts.isIfStatement(node)) {
    if (!canRegister(node, env)) continue;
    const condition = valueOf(node.expression, env);
    if (condition === unknown) diagnostic(node, 'Unresolved conditional registration; declare a supported static configuration.');
    else { const selected = condition ? node.thenStatement : node.elseStatement; if (selected) await statements([selected], new Map(env), owner); }
   } else if (ts.isForOfStatement(node)) {
    if (!canRegister(node.statement, env)) continue;
    const values = valueOf(node.expression, env);
    if (!Array.isArray(values) || values.length > limit) { diagnostic(node, 'Unresolved or unbounded registration loop.'); continue; }
    for (const value of values) {
     const scope = new Map(env), binding = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0].name : node.initializer;
     bind(binding, value, scope); await statements([node.statement], scope, owner);
    }
   } else if (ts.isForStatement(node)) {
    if (!canRegister(node.statement, env)) continue;
    const scope = new Map(env), declaration = ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations[0];
    if (!declaration || !ts.isIdentifier(declaration.name)) { diagnostic(node, 'Unresolved registration loop initializer.'); continue; }
    bind(declaration.name, valueOf(declaration.initializer, scope), scope);
    let iterations = 0;
    while (true) {
     const condition = valueOf(node.condition, scope);
     if (condition === unknown || ++iterations > limit) { diagnostic(node, 'Unresolved or unbounded registration loop.'); break; }
     if (!condition) break;
     await statements([node.statement], new Map(scope), owner);
     const increment = node.incrementor;
     if (increment && (ts.isPostfixUnaryExpression(increment) || ts.isPrefixUnaryExpression(increment)) && ts.isIdentifier(increment.operand) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(increment.operator)) scope.set(increment.operand.text, scope.get(increment.operand.text) + (increment.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1));
     else { diagnostic(node, 'Unresolved registration loop increment.'); break; }
    }
   } else if (ts.isTryStatement(node)) {
    await statements(node.tryBlock.statements, new Map(env), owner);
    if (node.catchClause && canRegister(node.catchClause, env)) diagnostic(node, 'Exception-dependent registration is unresolved.');
    if (node.finallyBlock) await statements(node.finallyBlock.statements, new Map(env), owner);
   } else if (canRegister(node, env)) diagnostic(node, 'Unsupported dynamic registration syntax.');
  }
  return unknown;
 }
 function hasAssertions(node, env, seen = new Set()) {
  if (!node) return false;
  let found = false;
  function visit(child) {
   if (found || ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child)) return;
   if (ts.isCallExpression(child)) {
    const callable = valueOf(child.expression, env);
    if (callable === assertion) { found = true; return; }
    if (callable === registrar || callable === suite || callable?.kind === 'cases') return;
    if (isFunction(callable) && !seen.has(callable.node)) {
     const scope = new Map(callable.env);
     callable.node.parameters.forEach((parameter, index) => bind(parameter.name, valueOf(child.arguments[index], env), scope));
     if (hasAssertions(callable.node.body, scope, new Set(seen).add(callable.node))) { found = true; return; }
    }
   }
   ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
 }
 async function evaluate(module) {
  if (!module || module.evaluated) return;
  module.evaluated = true;
  for (const imported of module.imports) await evaluate(imported);
  if (canRegister(module.source, module.env)) {
   for (const error of module.source.parseDiagnostics) diagnostic(module.source, `Cannot parse registration source: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
   await statements(module.source.statements, module.env, name(module.source.fileName));
  }
 }
 return {
  async prepare(files) { for (const file of files) await load(file); },
  async count(files, assertEntries) {
   for (const file of files) await evaluate(modules.get(file));
   const reached = new Set();
   function visitEntry(module) {
    if (!module || reached.has(module)) return;
    reached.add(module);
    for (const imported of module.imports) visitEntry(imported);
    const file = name(module.source.fileName);
    if (!contributions.has(file) && hasAssertions(module.source, module.env)) add(file);
   }
   for (const file of assertEntries) visitEntry(modules.get(file));
   const report = [...contributions].sort(([a], [b]) => a.localeCompare(b)).map(([file, count]) => ({ file, count }));
   return { total: report.reduce((sum, file) => sum + file.count, 0), files: report, diagnostics: [...diagnostics].sort() };
  },
 };
}
