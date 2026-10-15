import { memberName } from './site-syntax.mjs';

// Follow actual browser object provenance. An object's field named `href`,
// or a URL parser's `href` setter, does not make that object a DOM element.
export function browserObjects({expressions, origins, strings, global}) {
 const window = node => ['window','globalThis','self'].some(name => global(node, name));
 const document = node => global(node, 'document');
 const location = node => global(node, 'location') || origins(node).some(value => memberName(value) === 'location' && (window(value.object) || document(value.object)));
 const constructed = (node, name) => expressions(node).some(value => value.type === 'NewExpression' && global(value.callee, name));
 const queries = new Set(['querySelector','querySelectorAll','getElementById','getElementsByTagName','getElementsByClassName','getElementsByName','createElement','createElementNS']);
 const children = new Set(['body','head','documentElement','activeElement','firstChild','lastChild','firstElementChild','lastElementChild','nextSibling','previousSibling','nextElementSibling','previousElementSibling','parentNode','parentElement','children','childNodes','forms','images','links','content','contentDocument']);
 function dom(node, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen = new Set(seen).add(node);
  return expressions(node).some(value => {
   if (document(value)) return true;
   if (value.type === 'NewExpression') return ['Image','Audio','Option'].some(name => global(value.callee, name));
   if (value.type === 'CallExpression') {
    const method = memberName(value.callee), object = value.callee.object;
    return (queries.has(method) || ['closest','cloneNode','item','namedItem'].includes(method)) && dom(object, seen);
   }
   if (value.type !== 'MemberExpression') return false;
   return (children.has(memberName(value)) || value.computed) && dom(value.object, seen);
  });
 }
 function anchor(node) {
  return expressions(node).some(value => {
   if (value.type !== 'CallExpression' || !dom(value.callee.object)) return false;
   const method = memberName(value.callee);
   if (['createElement','createElementNS','getElementsByTagName'].includes(method)) return strings(value.arguments[method === 'createElementNS' ? 1 : 0]).some(tag => /^(?:a|area)$/i.test(tag));
   return ['querySelector','closest'].includes(method) && strings(value.arguments[0]).some(selector => /^(?:a|area)(?:[.#[:]|$)/i.test(selector));
  });
 }
 const style = node => expressions(node).some(value => memberName(value) === 'style' && dom(value.object));
 return {window, document, location, constructed, dom, anchor, style};
}
