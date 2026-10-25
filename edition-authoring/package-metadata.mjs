// Strict package.json metadata, without evaluating origin code. JSON.parse owns
// JSON syntax; this iterative token walk retains the object-key spellings and
// duplicates it discards. Reject ambiguity in every object, including nested
// unrelated metadata, while name/type constraints apply only at the root.
export function packageMetadata(text) {
  const config = JSON.parse(text);
  const location = position => {
    const lines = text.slice(0, position).split('\n');
    return `position ${position} (line ${lines.length} column ${lines.at(-1).length + 1})`;
  };
  const fail = (message, position) => { throw new SyntaxError(`${message} at ${location(position)}`); };
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('Expected a package object', 0);
  const stack = [], fields = new Map();
  let index = 0;
  // Syntax has already been validated. Skip complete string tokens, respecting
  // escaped quotes/backslashes; punctuation inside values is never structural.
  const string = () => {
    const start = index++;
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    index++;
    return text.slice(start, index);
  };
  while (index < text.length) {
    const char = text[index], frame = stack.at(-1);
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? {keys: new Set(), key: true} : {});
      index++;
    } else if (char === '}' || char === ']') {
      stack.pop(); index++;
    } else if (char === ',') {
      if (frame.keys) frame.key = true;
      index++;
    } else if (char === '"') {
      const start = index, token = string();
      if (!frame.key) continue;
      if (token.includes('\\')) fail('Escaped object key spelling is unsupported', start);
      const key = JSON.parse(token);
      if (frame.keys.has(key)) fail(`Duplicate object key ${token}`, start);
      frame.keys.add(key); frame.key = false;
      if (stack.length === 1) fields.set(key, start);
    } else index++;
  }
  for (const key of ['name', 'type']) {
    if (Object.hasOwn(config, key) && typeof config[key] !== 'string') fail(`Package ${key} must be a string`, fields.get(key));
  }
  return config;
}
