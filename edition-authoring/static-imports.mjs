// The module specifiers of a JavaScript file's static `import ... from`, bare
// `import`, and `export ... from` declarations, in source order. Dynamic import(),
// import.meta, and text inside strings, templates, regular expressions and
// comments are not declarations. A file whose declarations cannot be established
// throws; callers refuse rather than guess.
import {tokenize, Unclassifiable} from './js-tokens.mjs';

const MAXIMUM_READINGS = 32;
const string = token => token?.type === 'string';
const punctuation = (token, value) => token?.type === 'p' && token.value === value;
const word = (token, value) => token?.type === 'id' && token.value === value;
const unquote = raw => raw.slice(1, -1).replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|(0(?!\d))|(\d)|([\s\S]))/g,
  (_, point, unicode, hex, continuation, nul, octal, character) => {
    if (octal || (point && parseInt(point, 16) > 0x10FFFF)) throw new Unclassifiable('legacy escape in a module specifier');
    if (continuation) return '';
    if (nul) return '\0';
    if (character === 'u' || character === 'x') throw new Unclassifiable('invalid escape in a module specifier');
    return point || unicode || hex ? String.fromCodePoint(parseInt(point || unicode || hex, 16)) : {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v'}[character] ?? character;
  });

function declarations(tokens) {
  const found = [];
  const fail = reason => { throw new Unclassifiable(reason); };
  const importClause = start => {
    if (string(tokens[start + 1])) { found.push(tokens[start + 1].value); return start + 1; }
    let braces = 0;
    for (let j = start + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (punctuation(token, '{')) braces++;
      else if (punctuation(token, '}') && braces) braces--;
      else if (!braces && word(token, 'from') && string(tokens[j + 1])) { found.push(tokens[j + 1].value); return j + 1; }
      else if (!(token.type === 'id' || punctuation(token, ',') || punctuation(token, '*') || (braces && string(token)))) break;
    }
    return fail('unrecognised import declaration');
  };
  const exportClause = start => {
    let j = start + 1;
    if (punctuation(tokens[j], '*')) {
      if (word(tokens[++j], 'as')) j += 2;
    } else if (punctuation(tokens[j], '{')) {
      for (j++; !punctuation(tokens[j], '}'); j++) if (!(tokens[j]?.type === 'id' || string(tokens[j]) || punctuation(tokens[j], ','))) fail('unrecognised export declaration');
      j++;
      if (!word(tokens[j], 'from')) return j - 1;
    } else return start;
    if (!word(tokens[j], 'from') || !string(tokens[j + 1])) fail('unrecognised export declaration');
    found.push(tokens[j + 1].value);
    return j + 1;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'id' || token.depth || token.dot) continue;
    if (token.value === 'import' && !punctuation(tokens[i + 1], '(') && !punctuation(tokens[i + 1], '.')) i = importClause(i);
    else if (token.value === 'export') i = exportClause(i);
  }
  return found.map(token => unquote(token));
}

// Slashes the tokenizer cannot classify are tried both ways; every reading that
// lexes must agree on the declarations.
export function staticImports(text) {
  const readings = [];
  const explore = prefix => {
    if (readings.length >= MAXIMUM_READINGS) throw new Unclassifiable('too many ambiguous slashes');
    let asked = 0, specifiers, error;
    try { specifiers = declarations(tokenize(text, () => prefix[asked++] ?? false)); } catch (thrown) { if (!(thrown instanceof Unclassifiable)) throw thrown; error = thrown; }
    readings.push({specifiers, error});
    for (let j = prefix.length; j < asked; j++) explore([...prefix, ...Array(j - prefix.length).fill(false), true]);
  };
  explore([]);
  const lexed = readings.filter(reading => !reading.error);
  if (!lexed.length) throw readings[0].error;
  if (lexed.some(reading => JSON.stringify(reading.specifiers) !== JSON.stringify(lexed[0].specifiers))) throw new Unclassifiable('a slash could be division or a regular expression and the readings disagree');
  return lexed[0].specifiers;
}
