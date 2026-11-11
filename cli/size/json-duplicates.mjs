// JSON.parse keeps the last of two equal keys, so a repeated persona name would vanish before any rule ran.
// This reads text that JSON.parse already accepted and returns the path of every object key that repeats.
export function duplicateKeys(text) {
 const duplicates = [];
 let at = 0;
 const space = () => { while (/\s/.test(text[at])) at++; };
 const string = () => {
  const start = at++;
  while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
  return JSON.parse(text.slice(start, ++at));
 };
 function value(path) {
  space();
  if (text[at] === '{') {
   at++;
   const seen = new Set();
   space();
   if (text[at] === '}') { at++; return; }
   for (;;) {
    space();
    const key = string();
    if (seen.has(key)) duplicates.push([...path, key]);
    seen.add(key);
    space(); at++;
    value([...path, key]);
    space();
    if (text[at++] === '}') return;
   }
  }
  if (text[at] === '[') {
   at++;
   space();
   if (text[at] === ']') { at++; return; }
   for (let index = 0; ; index++) {
    value([...path, index]);
    space();
    if (text[at++] === ']') return;
   }
  }
  if (text[at] === '"') { string(); return; }
  while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
 }
 value([]);
 return duplicates;
}
