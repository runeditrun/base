import { decodedText } from './site-data.mjs';

// CSS strings and identifiers have their own escapes; comments can separate an
// at-rule or a function from its value. Tokenize them before selecting URLs.
export const decodeCSS = text => text.replace(/\\(?:([\da-f]{1,6})\s?|([^\r\n\f]))|\\(?:\r\n|[\r\n\f])/gi, (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16) > 0x10ffff ? 0xfffd : parseInt(hex, 16) || 0xfffd) : char ?? '');
function cssTokens(text) {
 const tokens = [];
 for (let i = 0; i < text.length;) {
  if (/\s/.test(text[i])) { i++; continue; }
  if (text.slice(i, i + 2) === '/*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
  const start = i, quote = text[i] === '"' || text[i] === "'" ? text[i++] : null;
  if (quote) {
   const begin = i;
   while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
   tokens.push({type:'string', value:decodeCSS(text.slice(begin, i))}); i++;
  } else if (/[a-z0-9_@#./%~-]/i.test(text[i]) || text[i] === '\\') {
   while (i < text.length && !/[\s(){};:,"']/.test(text[i])) {
    if (text[i] === '\\') { const escape = /^\\(?:[\da-f]{1,6}\s?|[^\r\n\f])/i.exec(text.slice(i)); if (escape) { i += escape[0].length; continue; } }
    if (text.slice(i, i + 2) === '/*') break;
    i++;
   }
   tokens.push({type:'word', value:decodeCSS(text.slice(start, i))});
  } else tokens.push({type:text[i], value:text[i++]});
 }
 return tokens;
}
export const cssStrings = text => cssTokens(text).filter(token => token.type === 'string').map(token => token.value);
export function cssReferences(text) {
 const tokens = cssTokens(text), found = [];
 for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i], name = token.value.toLowerCase();
  if (token.type === 'word' && ['@import','@use','@forward'].includes(name) && tokens[i + 1]?.type === 'string') found.push({url:tokens[i + 1].value, import:true, navigates:false});
  if (token.type === 'word' && name === 'url' && tokens[i + 1]?.type === '(') {
   let j = i + 2, url = '';
   while (j < tokens.length && tokens[j].type !== ')') url += tokens[j++].value;
   found.push({url, import:tokens[i - 1]?.value.toLowerCase() === '@import', navigates:false});
  }
  if (token.type === 'word' && ['image-set','-webkit-image-set'].includes(name) && tokens[i + 1]?.type === '(') {
   for (let j = i + 2, depth = 1; j < tokens.length && depth; j++) {
    if (tokens[j].type === '(') depth++;
    if (tokens[j].type === ')') depth--;
    if (depth === 1 && tokens[j].type === 'string') found.push({url:tokens[j].value,navigates:false});
   }
  }
 }
 return found;
}

// Attribute values may be quoted or unquoted. Raw script/style content is not
// parsed as tags, and a quoted greater-than sign does not end its tag.
export function htmlElements(text) {
 const elements = [], tags = /<!--[\s\S]*?(?:-->|$)|<([a-z][a-z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi;
 for (let match; (match = tags.exec(text));) {
  if (!match[1]) continue;
  const tag = match[1].toLowerCase(), attributes = new Map();
  for (const attribute of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
   const name = attribute[1].toLowerCase();
   if (!attributes.has(name)) attributes.set(name, decodedText(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
  }
  let content;
  if (['script','style','textarea','title'].includes(tag)) {
   const end = new RegExp('</' + tag + '\\s*>', 'ig'); end.lastIndex = tags.lastIndex;
   const closing = end.exec(text);
   content = text.slice(tags.lastIndex, closing?.index ?? text.length);
   tags.lastIndex = closing ? end.lastIndex : text.length;
  }
  elements.push({tag, attributes, content});
 }
 return elements;
}

// Preserve markup/CSS string boundaries when those languages occur inside a
// JavaScript string. A quote delimiting an attribute is not part of its value.
export function markupStrings(text) {
 const values = [];
 for (const {tag, attributes, content} of htmlElements(text)) {
  values.push(...attributes.values());
  if (tag === 'style') values.push(...cssStrings(content));
  if (attributes.has('style')) values.push(...cssStrings(attributes.get('style')));
  if (attributes.has('srcdoc')) values.push(...markupStrings(attributes.get('srcdoc')));
 }
 return values;
}

// Shared for complete pages and markup created by a browser island.
export function markupReferences(text, html) {
 const found = [];
 if (!html) return cssReferences(text);
 for (const {tag, attributes, content} of htmlElements(text)) {
  const rel = attributes.get('rel') ?? '';
  if (tag === 'style') found.push(...cssReferences(content));
  for (const [attribute, value] of attributes) {
   const name = attribute === 'xlink:href' ? 'href' : attribute;
   if (name === 'style') found.push(...cssReferences(value));
   if (!['href','src','srcset','action','formaction','poster','data'].includes(name)) continue;
   const navigates = name === 'href' && (['a','area'].includes(tag) || (tag === 'link' && /\b(?:canonical|alternate|author|license|help|me)\b/i.test(rel)));
   const values = name === 'srcset' ? value.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean) : [value];
   for (const url of values) found.push({url, navigates});
  }
 }
 return found;
}
