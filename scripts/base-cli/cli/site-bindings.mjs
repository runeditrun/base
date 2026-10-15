import { walkSyntax, stringValue, memberName } from './site-syntax.mjs';
import { refuse } from './errors.mjs';
const finite = (values, key = value => value) => {
 const unique = [...new Map(values.map(value => [key(value), value])).values()];
 if (unique.length > 1024) throw refuse('The run site has too many possible values for a browser resource reference to check.');
 return unique;
};
const propertyNames = (node, strings) => {
 const key = node?.type === 'MemberExpression' ? node.property : node?.key;
 if (!key) return [];
 if (!node.computed) return [key.name ?? String(key.value)];
 return key.type === 'Literal' && typeof key.value === 'number' ? [String(key.value)] : [...strings(key)];
};

// Keep bindings lexical: a library's parameter or local variable must not take
// an unrelated same-named value from the island. Resolve finite constant values
// at a resource sink, rather than treating every URL-shaped string as a fetch.
export function localValues(tree) {
 const scopes = new WeakMap(), writesByName = new Map(), computedWrites = [], assigned = new WeakMap(), root = {bindings:new Map(), parent:null, function:true};
 const writeIndex = name => {
  if (!writesByName.has(name)) writesByName.set(name, {writes:new Set(), users:new Set()});
  return writesByName.get(name);
 };
 const bind = (scope, name, value) => {
  if (!scope.bindings.has(name)) scope.bindings.set(name, []);
  if (value) scope.bindings.get(name).push(value);
 };
 const lookup = (node, name) => {
  let scope = scopes.get(node);
  while (scope && !scope.bindings.has(name)) scope = scope.parent;
  return scope?.bindings.get(name);
 };
 const bindPattern = (scope, pattern, value) => {
  if (pattern.type === 'Identifier') { bind(scope, pattern.name, value); return; }
  if (pattern.type === 'RestElement') { bindPattern(scope, pattern.argument); return; }
  if (pattern.type === 'AssignmentPattern') { bindPattern(scope, pattern.left, value); bindPattern(scope, pattern.left, pattern.right); return; }
  for (const [index, item] of (pattern.type === 'ObjectPattern' ? pattern.properties : pattern.elements ?? []).entries()) {
   if (!item) continue;
   const target = pattern.type === 'ObjectPattern' ? item.value ?? item.argument : item;
   const key = pattern.type === 'ObjectPattern' ? item.key : {type:'Literal', value:index};
   const member = value && key ? {type:'MemberExpression', object:value, property:key, computed:pattern.type !== 'ObjectPattern' || item.computed || key.type === 'Literal'} : null;
   if (member) scopes.set(member, scope);
   bindPattern(scope, target, member);
  }
 };
 walkSyntax(tree, (node, path) => {
  const parent = path.at(-1);
  let scope = scopes.get(parent) ?? root;
  if (['FunctionDeclaration','ClassDeclaration'].includes(node.type) && node.id) bind(scope, node.id.name, node);
  if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) bind(scope, specifier.local.name);
  if (/^(?:FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/.test(node.type) || node.type === 'BlockStatement' || node.type === 'CatchClause') {
   scope = {bindings:new Map(), parent:scope, function:node.type !== 'BlockStatement' && node.type !== 'CatchClause'};
   if (node.type === 'FunctionExpression' && node.id) bind(scope, node.id.name, node);
   for (const param of node.params ?? (node.param ? [node.param] : [])) bindPattern(scope, param);
  }
  scopes.set(node, scope);
  if (node.type === 'VariableDeclarator') {
   if (parent.kind === 'var') while (!scope.function && scope.parent) scope = scope.parent;
   bindPattern(scope, node.id, node.init);
  }
 });
 walkSyntax(tree, node => {
  if (node.type !== 'AssignmentExpression') return;
  const operator = node.operator.slice(0, -1);
  const value = node.operator === '=' ? node.right : {type:['&&','||','??'].includes(operator) ? 'LogicalExpression' : 'BinaryExpression', operator, left:node.left, right:node.right};
  assigned.set(node, value);
  if (node.left.type === 'MemberExpression') {
   const name = memberName(node.left), write = {left:node.left, right:value};
   if (name === undefined) computedWrites.push(write);
   else writeIndex(name).writes.add(write);
  }
  if (node.left.type !== 'Identifier') return;
  lookup(node, node.left.name)?.push(value);
 });
 // Resolve each expression once into a shared dataflow graph. Dependencies
 // are re-evaluated only when they gain a value, so cyclic aliases converge
 // instead of exploring every possible path through member assignments.
 const expressionResults = new WeakMap(), expressionStates = new WeakMap(), stringStates = new WeakMap(), writeStates = new WeakMap(), pending = new Set();
 const states = kind => kind === 'strings' ? stringStates : expressionStates;
 let evaluating;
 const state = (map, node, kind) => {
  let result = map.get(node);
  if (!result) {
   result = {node, kind, values:new Set(), users:new Set()};
   map.set(node, result); pending.add(result);
  }
  if (evaluating) result.users.add(evaluating);
  return result;
 };
 const read = (node, kind = 'expressions') => node ? state(states(kind), node, kind).values : new Set();
 const keys = node => propertyNames(node, key => read(key, 'strings'));
 const memberWrites = name => {
  const index = writeIndex(name);
  if (evaluating) index.users.add(evaluating);
  return index.writes;
 };
 // A computed write joins the same fixed point as its key's bindings. Index
 // each discovered key once and wake only readers of that member name.
 for (const write of computedWrites) state(writeStates, write, 'writes');
 function indexWrite(write) {
  const names = keys(write.left);
  for (const name of names) {
   const index = writeIndex(name);
   if (index.writes.has(write)) continue;
   index.writes.add(write);
   for (const user of index.users) pending.add(user);
  }
  return names;
 }
 const isClass = node => ['ClassDeclaration','ClassExpression'].includes(node.type);
 function classProperties(constructor, wanted, isStatic, fields, seen = new Set()) {
  const found = new Map();
  if (!isClass(constructor) || seen.has(constructor)) return found;
  seen = new Set(seen).add(constructor);
  let unknownKey = false;
  for (const property of constructor.body.body) {
   if (Boolean(property.static) !== isStatic || (fields !== undefined && (property.type === 'PropertyDefinition') !== fields)) continue;
   const names = keys(property);
   if (property.computed && !names.length) unknownKey = true;
   for (const name of wanted) if (names.includes(name)) {
    // Static fields initialize after methods even when written before them.
    const previous = found.get(name)?.[0];
    if (property.type === 'PropertyDefinition' || previous?.type !== 'PropertyDefinition') found.set(name, [property]);
   }
  }
  const inherited = wanted.filter(name => !found.has(name));
  // Wait for a computed override's key instead of prematurely retaining the
  // inherited definition in the monotone graph. Unknown keys stay unknown.
  if (inherited.length && !unknownKey) for (const parent of read(constructor.superClass)) {
   for (const [name, properties] of classProperties(parent, inherited, isStatic, fields, seen)) found.set(name, [...(found.get(name) ?? []), ...properties]);
  }
  return found;
 }
 function classMembers(constructor, names, isStatic) {
  if (isStatic) return [...classProperties(constructor, names, true).values()].flat();
  // Instance fields shadow prototype methods, including a method declared by
  // a subclass. Within each category the nearest declaration wins.
  const fields = classProperties(constructor, names, false, true);
  const methods = classProperties(constructor, names.filter(name => !fields.has(name)), false, false);
  return [...fields.values(), ...methods.values()].flat();
 }
 function expressionValues(node) {
  if (node.type === 'Identifier') {
   const values = lookup(node, node.name);
   return values?.length ? values.flatMap(value => [...read(value)]) : [node];
  }
  if (node.type === 'MemberExpression') {
   const names = keys(node);
   const objects = read(node.object), members = [node];
   const properties = items => {
    for (const property of items) if (keys(property).some(key => names.includes(key))) members.push(...read(property.value));
   };
   for (const object of objects) {
    if (object.type === 'ArrayExpression') for (const key of names) members.push(...read(object.elements[Number(key)]));
    if (object.type === 'ObjectExpression') properties(object.properties);
    if (isClass(object)) properties(classMembers(object, names, true));
    if (object.type === 'NewExpression') for (const constructor of read(object.callee)) {
     if (isClass(constructor)) properties(classMembers(constructor, names, false));
    }
   }
   for (const key of names) for (const write of memberWrites(key)) {
    if (write.left !== node && [...read(write.left.object)].some(object => objects.has(object))) members.push(...read(write.right));
   }
   return members;
  }
  if (node.type === 'ConditionalExpression') return [...read(node.consequent), ...read(node.alternate)];
  if (node.type === 'LogicalExpression') return [...read(node.left), ...read(node.right)];
  if (node.type === 'SequenceExpression') return read(node.expressions.at(-1));
  if (node.type === 'AssignmentExpression') return read(assigned.get(node));
  return [node];
 }
 function stringValues(node, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  seen = new Set(seen).add(node);
  const value = stringValue(node);
  if (value !== undefined) return [value];
  if (node.type === 'BinaryExpression' && node.operator === '+') return finite(stringValues(node.left, seen).flatMap(left => stringValues(node.right, seen).map(right => left + right)));
  if (node.type === 'TemplateLiteral') {
   let values = [node.quasis[0].value.cooked ?? ''];
   for (let i = 0; i < node.expressions.length; i++) values = finite(values.flatMap(left => stringValues(node.expressions[i], seen).map(right => left + right + (node.quasis[i + 1].value.cooked ?? ''))));
   return values;
  }
  if (node.type === 'CallExpression' && ['decodeURI','decodeURIComponent','atob'].includes(node.callee.name)) return stringValues(node.arguments[0], seen).flatMap(value => {
   try {return [node.callee.name === 'atob' ? Buffer.from(value,'base64').toString('utf8') : decodeURIComponent(value)];} catch {return [];}
  });
  // Expand only the finite syntax graph. Recursive string construction has
  // an unknown tail, not an ever-growing set of invented complete strings.
  // Alias states already contain their transitive values; unresolved member
  // identities contain no additional strings and must not be expanded again.
  return finite([...read(node)].filter(value => value !== node && !['Identifier','MemberExpression'].includes(value.type)).flatMap(value => stringValues(value, seen)));
 }
 function resolve(node, kind) {
  if (!node) return [];
  const result = state(states(kind), node, kind);
  for (const next of pending) {
   pending.delete(next); evaluating = next;
   const values = next.kind === 'writes' ? indexWrite(next.node) : next.kind === 'strings' ? stringValues(next.node) : expressionValues(next.node);
   let changed = false;
   for (const value of values) if (!next.values.has(value)) { next.values.add(value); changed = true; }
   if (next.kind === 'strings') finite([...next.values]);
   if (changed) for (const user of next.users) pending.add(user);
  }
  evaluating = undefined;
  return [...result.values];
 }
 function expressions(node) {
  if (!node) return [];
  if (expressionResults.has(node)) return expressionResults.get(node);
  const values = resolve(node, 'expressions').filter(value => {
   if (value.type !== 'MemberExpression') return true;
   // A member is its own unresolved identity until a value reaches it. Keep
   // unresolved cycles, but remove that identity after resolving an alias.
   return ![...expressionStates.get(value).values].some(other => other !== value && (other.type !== 'MemberExpression' || !expressionStates.get(other)?.values.has(value)));
  });
  // Indexing is complete and every dependency has settled before caching.
  expressionResults.set(node, values);
  return values;
 }
 const strings = node => resolve(node, 'strings');
 const names = node => propertyNames(node, strings);
 const origins = expressions;
 const localClass = node => {
  const values = expressions(node);
  return values.length > 0 && values.every(value => {
   const constructors = value.type === 'NewExpression' ? expressions(value.callee) : [value];
   return constructors.length > 0 && constructors.every(isClass);
  });
 };
 // Recognize browser globals through aliases without mistaking library methods
 // or shadowed parameters for those APIs.
 function global(node, name, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen = new Set(seen).add(node);
  return origins(node).some(value => {
   if (value.type === 'Identifier') return value.name === name && !lookup(value, value.name);
   return value.type === 'MemberExpression' && names(value).includes(name) && ['window','globalThis','self'].some(root => global(value.object, root, seen));
  });
 }
 // A runtime suffix does not erase a known origin or route at a resource sink.
 // Retain only the prefix before the first unknown value; later fragments are
 // not a trustworthy prefix. Complete values still use ordinary file checks.
 const alternatives = values => finite(values, value => JSON.stringify(value));
 const combine = (left, right) => alternatives(left.flatMap(start => start.complete ? right.map(end => ({value:start.value + end.value, complete:end.complete})) : [start]));
 function resources(node, seen = new Set()) {
  const unknown = [{value:'', complete:false}];
  if (!node || seen.has(node)) return unknown;
  seen = new Set(seen).add(node);
  const value = stringValue(node);
  if (value !== undefined) return [{value, complete:true}];
  if (node.type === 'BinaryExpression' && node.operator === '+') return combine(resources(node.left, seen), resources(node.right, seen));
  if (node.type === 'TemplateLiteral') {
   let values = [{value:node.quasis[0].value.cooked ?? '', complete:true}];
   for (let i = 0; i < node.expressions.length; i++) values = combine(combine(values, resources(node.expressions[i], seen)), [{value:node.quasis[i + 1].value.cooked ?? '', complete:true}]);
   return values;
  }
  if (node.type === 'NewExpression' && global(node.callee, 'Request')) return resources(node.arguments[0], seen);
  if (node.type === 'NewExpression' && global(node.callee, 'URL')) {
   const targets = resources(node.arguments[0], seen), bases = resources(node.arguments[1], seen);
   const written = [...memberWrites('href')].filter(write => expressions(write.left.object).includes(node)).flatMap(write => resources(write.right, seen));
   return alternatives([...written, ...targets.flatMap(target => {
    // Absolute targets do not depend on the base. Incomplete targets retain
    // their known prefix, including a foreign origin or an instance subtree.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target.value)) return [target];
    if (!node.arguments[1]) return unknown;
    return bases.flatMap(base => {
     if (!base.complete) {
      if (target.value && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(base.value)) return [base];
      return target.value.startsWith('/') ? [target] : unknown;
     }
     try {
      if (!target.value && !target.complete) return unknown;
      return [{value:new URL(target.value, base.value).href, complete:target.complete}];
     } catch { return unknown; }
    });
   })]);
  }
  if (node.type === 'MemberExpression' && names(node).some(name => ['href','url'].includes(name))) {
   const objects = expressions(node.object), values = objects.flatMap(object => object.type === 'NewExpression' && (global(object.callee, 'URL') || global(object.callee, 'Request')) ? resources(object, seen) : []);
   if (values.length) return alternatives(values);
  }
  if (node.type === 'CallExpression' && names(node.callee).some(name => ['toString','toJSON'].includes(name))) {
   const values = expressions(node.callee.object).flatMap(object => object.type === 'NewExpression' && global(object.callee, 'URL') ? resources(object, seen) : []);
   if (values.length) return alternatives(values);
  }
  const resolved = expressions(node).filter(value => value !== node);
  if (resolved.length) return alternatives(resolved.flatMap(value => resources(value, seen)));
  const complete = strings(node);
  return complete.length ? complete.map(value => ({value, complete:true})) : unknown;
 }
 return {strings, names, resources, expressions, origins, global, localClass};
}
