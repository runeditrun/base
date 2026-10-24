// Keep the exported CLI independent of the seed's TypeScript runtime.
// Mirrors modules/business-settings/json.ts, including escaped-key aliases.
export function parseJson(text) {
 const value = JSON.parse(text);
 let position = 0;
 const whitespace = () => { while (position < text.length && /\s/.test(text[position])) position++; };
 function stringToken() {
  const start = position++;
  while (position < text.length) {
   const c = text[position++];
   if (c === '\\') position++;
   else if (c === '"') return JSON.parse(text.slice(start, position));
  }
  throw Error('Invalid JSON.');
 }
 function visit(depth) {
  if (depth > 16) throw Error('Invalid JSON.');
  whitespace();
  const opening = text[position];
  if (opening === '"') { stringToken(); return; }
  if (opening !== '{' && opening !== '[') {
   while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
   return;
  }
  position++; whitespace();
  const closing = opening === '{' ? '}' : ']', names = new Set();
  if (text[position] === closing) { position++; return; }
  for (;;) {
   if (opening === '{') {
    whitespace(); const key = stringToken();
    if (names.has(key)) throw Error('Invalid JSON.');
    names.add(key); whitespace(); position++;
   }
   visit(depth + 1); whitespace();
   if (text[position++] === closing) return;
  }
 }
 visit(0);
 return value;
}
