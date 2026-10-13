import { memberName, stringValue, walkSyntax } from './site-syntax.mjs';
import { localValues } from './site-bindings.mjs';
import { browserObjects } from './site-browser-objects.mjs';
import { markupReferences, cssReferences, markupStrings, cssStrings, htmlElements } from './site-markup.mjs';

// A firstChild expression is not a type proof: its parent may contain an
// object element. Admit CharacterData only from an unambiguous emitted text
// child, consistent across all pages, with no script that can replace it.
export function javascriptContext(documents, trees) {
 const children = new Map();
 // Recognize a balanced subset of ordinary HTML, rather than guessing at
 // browser repair rules. Tables, foreign content, templates and formatting
 // reconstruction leave every node unknown. Common page links, headings and
 // buttons are safe when explicitly closed in their ordinary insertion mode.
 const containers = new Set('p div span section article aside nav header footer main object a button h1 h2 h3 h4 h5 h6 ul ol li dl dt dd figure figcaption details summary'.split(' '));
 const voids = new Set('br hr img input link meta wbr'.split(' '));
 const raw = new Set(['script','style','title','textarea']);
 const ordinary = new Set([...containers, ...voids, ...raw, 'html','head','body']);
 const blocks = new Set('p div section article aside nav header footer main h1 h2 h3 h4 h5 h6 ul ol li dl dt dd figure figcaption details summary hr'.split(' '));
 const unknown = () => ({textParents:new Set()});
 for (const text of documents) {
  const seen = new Set(), structure = new Set(), stack = [];
  const tags = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\s*>|<\/?([a-z][a-z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>|[^<]+|</gi;
  for (let match; (match = tags.exec(text));) {
   if (match[0] === '<') return unknown();
   if (match[0].startsWith('<!--') && !/^<!--(?:[^<>-]|-(?!-))*-->$/.test(match[0])) return unknown();
   if (!match[1]) continue;
   const tag = match[1].toLowerCase();
   if (!ordinary.has(tag)) return unknown();
   if (match[0].startsWith('</')) {
    if (match[2].trim() || stack.pop() !== tag) return unknown();
    continue;
   }
   // Reject malformed attributes and non-void self-closing tags, which HTML
   // parses differently from XML. Never infer text from the repaired tree.
   if (!/^(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?$/.test(match[2]) || (!voids.has(tag) && /\/\s*$/.test(match[2]))) return unknown();
   if (stack.includes('head') && !['meta','link','title','style','script'].includes(tag)) return unknown();
   if ((blocks.has(tag) && stack.includes('p')) || (['a','button','li'].includes(tag) && stack.includes(tag)) || (/^h[1-6]$/.test(tag) && stack.some(parent => /^h[1-6]$/.test(parent))) || (['dt','dd'].includes(tag) && stack.some(parent => ['dt','dd'].includes(parent)))) return unknown();
   if (['html','head','body'].includes(tag)) {
    if (structure.has(tag) || stack.some(parent => parent !== 'html') || (tag === 'html' && stack.length) || (tag === 'head' && structure.has('body'))) return unknown();
    structure.add(tag);
   }
   const {attributes} = htmlElements(match[0])[0];
   if ([...attributes.keys()].some(name => name.startsWith('on'))) return unknown();
   const id = attributes.get('id');
   if (id !== undefined) {
    const firstText = /^[^<]*/.exec(text.slice(tags.lastIndex))[0].replace(/\0/g, '');
    const textChild = containers.has(tag) && firstText.length > 0;
    children.set(id, textChild && !seen.has(id) && children.get(id) !== false);
    seen.add(id);
   }
   if (raw.has(tag)) {
    if (tag === 'script' && !/^(?:|module|(?:text|application)\/(?:java|ecma)script|application\/(?:ld\+)?json)$/i.test(attributes.get('type') ?? '')) return unknown();
    const closing = new RegExp('</' + tag + '(?=[\\s/>])[^>]*>', 'ig'); closing.lastIndex = tags.lastIndex;
    const end = closing.exec(text);
    if (!end || !new RegExp('^</' + tag + '\\s*>$', 'i').test(end[0])) return unknown();
    if (tag === 'script' && /<!--|<script\b/i.test(text.slice(tags.lastIndex, end.index))) return unknown();
    tags.lastIndex = closing.lastIndex;
   } else if (!voids.has(tag)) stack.push(tag);
  }
  if (stack.length) return unknown();
 }
 // Include every emitted script: a different island can change the selected
 // element, its id or its children before this assignment runs.
 const nativeMethods = new Set(['querySelector','querySelectorAll','getElementById','getElementsByTagName','getElementsByClassName','getElementsByName','createElement','createElementNS','getAttribute','hasAttribute','addEventListener','removeEventListener','setAttribute','setAttributeNS','removeAttribute','removeAttributeNS']);
 const reflectiveMethods = new Set(['assign','defineProperty','defineProperties','setPrototypeOf','set','deleteProperty']);
 const writes = new Set(['id','innerHTML','outerHTML','textContent','innerText','outerText','srcdoc','document','head','firstChild','__proto__',...nativeMethods,...reflectiveMethods]);
 const changes = new Set(['before','after','append','prepend','appendChild','removeChild','replaceChild','replaceChildren','insertBefore','insertAdjacentHTML','insertAdjacentElement','insertAdjacentText','replaceWith','remove','write','writeln','setHTML','setHTMLUnsafe','normalize','insertNode','surroundContents','extractContents','deleteContents','adoptNode','execCommand','setAttributeNode','setAttributeNodeNS','__defineGetter__','__defineSetter__']);
 let stable = true;
 for (const tree of trees) {
  const values = localValues(tree), browser = browserObjects(values);
  // A newly created metadata link appended to the head cannot replace a
  // selected text child in the body. Its resource URLs still get checked.
  // Requiring fresh native nodes also excludes moving an existing child out
  // of a text parent. Any id write above still invalidates this proof.
  const documentObject = node => {
   const alternatives = values.origins(node);
   return alternatives.length > 0 && alternatives.every(browser.document);
  };
  const plainObject = node => {
   const receivers = values.origins(node);
   return receivers.length > 0 && receivers.every(value => value.type === 'ObjectExpression' && value.properties.every(property => property.type === 'Property' && property.kind === 'init'));
  };
  // Selector, traversal and head-link proofs depend on native DOM methods.
  // Writes to those members, including prototype mutation through reflection,
  // remove the proof across all emitted scripts. A known fresh plain object
  // can still receive ordinary metadata without changing the native APIs.
  const reflectiveMutation = node => values.names(node).some(name => reflectiveMethods.has(name))
   && ['Object','Reflect'].some(name => values.global(node.object, name));
  const writeTargets = node => {
   if (!node) return [];
   if (node.type === 'ObjectPattern') return node.properties.flatMap(property => writeTargets(property.value ?? property.argument));
   if (node.type === 'ArrayPattern') return node.elements.flatMap(writeTargets);
   if (node.type === 'AssignmentPattern') return writeTargets(node.left);
   if (node.type === 'RestElement') return writeTargets(node.argument);
   return [node];
  };
  const headLink = node => {
   if (node?.type !== 'CallExpression' || memberName(node.callee) !== 'appendChild' || node.arguments.length !== 1) return false;
   const receivers = values.origins(node.callee.object), arguments_ = values.origins(node.arguments[0]);
   return receivers.length > 0 && receivers.every(receiver => memberName(receiver) === 'head' && documentObject(receiver.object))
    && arguments_.length > 0 && arguments_.every(value => value.type === 'CallExpression' && memberName(value.callee) === 'createElement' && value.arguments.length === 1
     && documentObject(value.callee.object) && values.resources(value.arguments[0]).every(tag => tag.complete && tag.value.toLowerCase() === 'link'));
  };
  walkSyntax(tree, (node, parents) => {
   const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete') ? node.argument : undefined;
   for (const write of writeTargets(target)) {
    if (write.type === 'Identifier' && values.global(write, 'document')) stable = false;
    if (write.type !== 'MemberExpression') continue;
    const fields = values.names(write);
    if ((!fields.length && !plainObject(write.object)) || fields.some(name => writes.has(name))) stable = false;
   }
   if (node.type === 'Property' && values.names(node).some(name => writes.has(name) || changes.has(name))) stable = false;
   if (node.type === 'MemberExpression' && values.names(node).some(name => name === 'attributes' || changes.has(name)) && !headLink(parents.at(-1))) stable = false;
   if (node.type === 'MemberExpression' && reflectiveMutation(node)) {
    const call = parents.at(-1);
    if (call?.type !== 'CallExpression' || call.callee !== node || !plainObject(call.arguments[0])) stable = false;
   }
   if (!['CallExpression','NewExpression'].includes(node.type)) return;
   if (values.global(node.callee, 'eval') || values.global(node.callee, 'Function')) stable = false;
   const appendsHeadLink = headLink(node);
   for (const callee of values.origins(node.callee)) {
    const methods = values.names(callee);
    if (reflectiveMutation(callee) && !plainObject(node.arguments[0])) stable = false;
    if (methods.some(name => changes.has(name)) && !appendsHeadLink) stable = false;
    if (methods.some(name => ['setAttribute','setAttributeNS','removeAttribute','removeAttributeNS'].includes(name))) {
     const index = methods.some(name => name.endsWith('NS')) ? 1 : 0, attributes = values.resources(node.arguments[index]);
     if (attributes.some(({value, complete}) => !complete || /^(?:id|on.*)$/i.test(value))) stable = false;
    } else if (!appendsHeadLink && node.arguments.some(argument => browser.dom(argument))) stable = false;
    if (!appendsHeadLink && callee.type === 'MemberExpression' && (!methods.length || (browser.dom(callee.object) && methods.some(name => !nativeMethods.has(name))))) stable = false;
   }
  });
 }
 return {textParents:new Set(stable ? [...children].filter(([,text]) => text).map(([id]) => id) : [])};
}

export function javascriptContent(tree, {textParents = new Set()} = {}) {
 const values = localValues(tree), {strings, names, resources, origins, global, localClass} = values;
 const browser = browserObjects(values), found = [], literals = [], unresolved = [];
 const properties = new Set(['src','href','srcset','action','formaction','poster','data']);
 // Unknown DOM nodes retain the data URL check. A selector or traversal
 // alone cannot distinguish HTMLObjectElement from CharacterData.
 const characterData = node => {
  const alternatives = origins(node);
  return alternatives.length > 0 && alternatives.every(value => {
   if (value.type !== 'MemberExpression' || memberName(value) !== 'firstChild') return false;
   const parents = origins(value.object);
   return parents.length > 0 && parents.every(parent => {
    if (parent.type !== 'CallExpression') return false;
    const receivers = origins(parent.callee.object);
    if (!receivers.length || !receivers.every(browser.document)) return false;
    const method = memberName(parent.callee), selectors = resources(parent.arguments[0]);
    return ['querySelector','getElementById'].includes(method) && selectors.length > 0 && selectors.every(({value, complete}) => {
     const id = method === 'getElementById' ? value : /^#([a-z_][\w-]*)$/i.exec(value)?.[1];
     return complete && id !== undefined && textParents.has(id);
    });
   });
  });
 };
 const elementFactory = callee => {
  const methods = names(callee);
  if (!methods.some(name => ['createElement','jsx','jsxs','jsxDEV'].includes(name)) || localClass(callee.object)) return false;
  const receivers = origins(callee.object);
  // Native document construction takes options, whereas framework factories
  // render props. Mixed receiver alternatives must retain their framework use.
  return !(methods.every(name => name === 'createElement') && receivers.length && receivers.every(browser.document));
 };
 const add = (node, kind, navigates = false, documentRelative = true, srcset = false) => {
  const targets = resources(node);
  if (targets.some(target => !target.complete)) unresolved.push({kind});
  for (const {value, complete} of targets) for (const url of srcset ? value.split(',').map(part => part.trim().split(/\s+/)[0]) : [value]) found.push({url, navigates, documentRelative, dynamic:!complete});
 };
 const css = (node, emitted) => {for (const {value, complete} of resources(node)) {
  literals.push(...cssStrings(value));
  if (!emitted) continue;
  const references = cssReferences(value);
  found.push(...references.map(reference => ({...reference,documentRelative:true,dynamic:!complete})));
  if (!complete && references.length) unresolved.push({kind:'CSS.url'});
 }};
 const markup = (node, emitted) => { for (const value of strings(node)) {
  literals.push(...markupStrings(value));
  if (emitted) found.push(...markupReferences(value, true).map(reference => ({...reference, documentRelative:true})));
 }};
 walkSyntax(tree, node => {
  if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type) && node.source) add(node.source, node.type === 'ImportExpression' ? 'import()' : 'import', false, false);
  if (node.type === 'AssignmentExpression') {
   const object = node.left.object, fields = names(node.left);
   if (browser.location(node.left)) add(node.right, 'location.href');
   for (const property of fields) {
    const name = property.toLowerCase();
    if (properties.has(name) && browser.dom(object) && (name !== 'data' || !characterData(object))) add(node.right, `DOM.${property}`, name === 'href' && browser.anchor(object), true, name === 'srcset');
    if (property === 'href' && browser.location(object)) add(node.right, 'location.href');
    if (['innerHTML','outerHTML','srcdoc'].includes(property)) markup(node.right, browser.dom(object));
   }
   // String extraction retains its privacy scope even for inert object fields.
   if (fields.some(property => ['style','cssText'].includes(property)) || origins(object).some(value => memberName(value) === 'style')) css(node.right, browser.style(object) || (fields.includes('style') && browser.dom(object)));
  }
  if (node.type === 'Property') {
   const property = node.computed ? stringValue(node.key) : node.key.name ?? node.key.value;
   // Keep extracting private text from stored markup; resource use is checked
   // where the value reaches a DOM write or a recognized element factory.
   if (property === '__html') markup(node.value, false);
  }
  if (!['CallExpression','NewExpression'].includes(node.type)) return;
  const args = node.arguments;
  const createsElement = node.type === 'CallExpression' && origins(node.callee).some(elementFactory);
  const tags = createsElement ? strings(args[0]) : [];
  if (tags.length) for (const props of origins(args[1])) {
   if (props.type !== 'ObjectExpression') continue;
   for (const field of props.properties) for (const property of names(field)) {
    if (properties.has(property.toLowerCase())) add(field.value, `DOM.${property}`, property === 'href' && tags.some(tag => ['a','area'].includes(tag)), true, property.toLowerCase() === 'srcset');
    if (property === 'dangerouslySetInnerHTML') for (const html of origins(field.value)) {
     if (html.type === 'ObjectExpression') for (const content of html.properties) if (names(content).includes('__html')) markup(content.value, true);
    }
   }
  }
  for (const name of ['fetch','Worker','SharedWorker','WebSocket','EventSource']) if (global(node.callee, name)) add(args[0], name);
  for (const callee of origins(node.callee)) for (const method of names(callee)) {
   const object = callee.object;
   if (method === 'sendBeacon' && global(object, 'navigator')) add(args[0], 'navigator.sendBeacon');
   // URL and Request construct data. Their arguments are resolved only when
   // the resulting value reaches a resource operation such as fetch.
   if (method === 'setProperty' && origins(object).some(value => memberName(value) === 'style')) css(args[1], browser.style(object));
   if (method === 'open') {
    if (browser.window(object)) add(args[0], 'window.open');
    else if (browser.constructed(object, 'XMLHttpRequest')) add(args[1], 'XMLHttpRequest.open');
   }
   if (['assign','replace'].includes(method) && browser.location(object)) add(args[0], `location.${method}`);
   if (['setAttribute','setAttributeNS'].includes(method)) {
    const index = method === 'setAttributeNS' ? 1 : 0;
    for (const attribute of strings(args[index])) {
     const property = attribute.toLowerCase();
     if (properties.has(property) && browser.dom(object)) add(args[index + 1], `DOM.${method}(${property})`, property === 'href' && browser.anchor(object), true, property === 'srcset');
     if (property === 'srcdoc') markup(args[index + 1], browser.dom(object));
     if (property === 'style') css(args[index + 1], browser.dom(object));
    }
   }
   if (method === 'insertAdjacentHTML') markup(args[1], browser.dom(object));
   if (method === 'write' || method === 'writeln') for (const argument of args) markup(argument, browser.document(object));
  }
 });
 return {references:found, unresolved, literals};
}
