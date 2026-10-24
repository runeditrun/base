// JavaScript tokenizer for static-import discovery. It decides regular expression
// versus division exactly where the previous token determines it, and reports the
// few positions it cannot decide (a slash after `}` or after a word that is a
// keyword only in some contexts) so the caller can try both readings. Anything it
// cannot lex throws Unclassifiable; it never guesses.
export class Unclassifiable extends Error {}

const LINE = /[\n\r\u2028\u2029]/;
const IDENTIFIER = new RegExp(String.raw`#?(?:[\p{ID_Start}$_]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})(?:[\p{ID_Continue}$\u200c\u200d]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})*`, 'uy');
const FLAGS = new RegExp(String.raw`(?:[\p{ID_Continue}$\u200c\u200d]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})*`, 'uy');
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const SPACE = /\s/;
const punctuation = (token, value) => token?.type === 'p' && token.value === value;
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
// A slash after these words starts a regular expression unless the word is a property name.
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'void', 'delete', 'throw', 'new', 'case', 'do', 'else', 'extends', 'default', 'try', 'finally']);
// Keywords in modules and generators, identifiers elsewhere.
const CONTEXTUAL = new Set(['of', 'yield', 'await']);
const CONTROL = new Set(['if', 'while', 'for', 'with']);
// Parentheses whose `)` is followed by a statement block, and words directly followed by one.
const HEADER = new Set([...CONTROL, 'switch', 'catch']);
// What a slash after the closing brace means, by what the brace opened.
const BODY_SLASH = {'{': 'either', block: 'regex', object: 'div', 'body-expression': 'div', 'body-statement': 'regex', 'body-unknown': 'either'};
const BRACES = new Set(Object.keys(BODY_SLASH));
// Words after which an expression, not a statement, must follow.
const OPERAND_WORDS = new Set([...BEFORE_EXPRESSION].filter(word => !['do', 'else', 'default', 'try', 'finally'].includes(word)).concat('await', 'yield'));
const BLOCK_WORDS = new Set(['else', 'try', 'finally', 'do', 'with', 'catch', 'export']);
// Whether a `function` or `class` after this token is an expression, a statement,
// or cannot be told apart from the token alone.
const positionAfter = (behind, stack) => {
  if (!behind) return 'statement';
  if (behind.open) return 'expression';
  if (behind.type === 'id' && !behind.dot) return OPERAND_WORDS.has(behind.value) ? 'expression' : behind.value === 'of' ? 'unknown' : 'statement';
  if (behind.type !== 'p') return 'statement';
  if (behind.value === ';') return stack.length && !BRACES.has(stack.at(-1)) ? 'unknown' : 'statement';
  if (behind.value === ':' || behind.value === '++' || behind.value === '--') return 'unknown';
  return /^[{}):\]]$/.test(behind.value) ? 'statement' : 'expression';
};

// `choose()` answers each undecidable choice: true reads a regular expression.
export function tokenize(text, choose) {
  const tokens = [], stack = [], n = text.length;
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0, slash = 'regex', newline = false, body = null;
  const fail = reason => { throw new Unclassifiable(`${reason} at line ${1 + (text.slice(0, i).match(/\n/g) || []).length}`); };
  const push = (type, value, next) => {
    const previous = tokens.at(-1);
    tokens.push({type, value, depth: stack.length, dot: previous?.type === 'p' && (previous.value === '.' || previous.value === '?.')});
    i = next; newline = false;
  };
  const template = start => {
    for (let j = start; j < n; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '`') { push('template', '', j + 1); slash = 'div'; return; }
      else if (text[j] === '$' && text[j + 1] === '{') { push('template', '', j + 2); tokens.at(-1).open = true; stack.push('${'); slash = 'regex'; return; }
    }
    fail('unterminated template literal');
  };
  // The lexical grammar does not nest classes, whatever the flags say.
  const regex = start => {
    let inClass = false;
    for (let j = start + 1; j < n; j++) {
      const c = text[j];
      if (c === '\\') { if (LINE.test(text[j + 1] ?? '\n')) break; j++; }
      else if (LINE.test(c)) break;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { FLAGS.lastIndex = j + 1; FLAGS.exec(text); push('regex', '', FLAGS.lastIndex); slash = 'div'; return; }
    }
    fail('unterminated regular expression');
  };
  if (text.startsWith('#!', i)) while (i < n && !LINE.test(text[i])) i++;
  while (i < n) {
    const c = text[i];
    if (SPACE.test(c)) { if (LINE.test(c)) newline = true; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && !LINE.test(text[i])) i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated comment');
      if (LINE.test(text.slice(i, end))) newline = true;
      i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < n && text[j] !== c; j++) {
        if (text[j] === '\\') { if (text[j + 1] === '\r' && text[j + 2] === '\n') j++; j++; }
        else if (text[j] === '\n' || text[j] === '\r') fail('unterminated string');
      }
      if (j >= n) fail('unterminated string');
      // A module specifier ends its declaration, so a slash after it starts a statement.
      const before = tokens.at(-1);
      const specifier = !stack.length && before?.type === 'id' && !before.dot && (before.value === 'from' || before.value === 'import');
      push('string', text.slice(i, j + 1), j + 1); slash = specifier ? 'regex' : 'div'; continue;
    }
    if (c === '`') { template(i + 1); continue; }
    if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] ?? ''))) {
      NUMBER.lastIndex = i; NUMBER.exec(text);
      push('number', '', NUMBER.lastIndex); slash = 'div'; continue;
    }
    IDENTIFIER.lastIndex = i;
    if (IDENTIFIER.test(text)) {
      const word = text.slice(i, IDENTIFIER.lastIndex);
      push('id', word, IDENTIFIER.lastIndex);
      // Only a keyword: as a property key or field name the next token is `:`, `=`, `,`, `;` or `}`.
      if ((word === 'function' || word === 'class') && !tokens.at(-1).dot && /^\s*[(*{\p{ID_Start}$_\\]/u.test(text.slice(i, i + 64))) {
        const behind = tokens.at(-2)?.value === 'async' && tokens.at(-2).type === 'id' && word === 'function' ? tokens.at(-3) : tokens.at(-2);
        body = {depth: stack.length, kind: 'body-' + positionAfter(behind, stack)};
      }
      slash = tokens.at(-1).dot || word.startsWith('#') ? 'div' : BEFORE_EXPRESSION.has(word) ? 'regex' : CONTEXTUAL.has(word) ? 'either' : 'div';
      continue;
    }
    if (c === '/') {
      const literal = slash === 'regex' || (slash === 'either' && choose());
      if (literal) { regex(i); continue; }
      push('p', text[i + 1] === '=' ? '/=' : '/', i + (text[i + 1] === '=' ? 2 : 1)); slash = 'regex';
      continue;
    }
    if (c === '<' && text.startsWith('<!--', i)) fail('HTML-like comment');
    if (c === '-' && text.startsWith('-->', i) && (newline || !tokens.length)) fail('HTML-like comment');
    let value = PUNCTUATORS.find(p => text.startsWith(p, i)) ?? c;
    if (value === '?.' && /\d/.test(text[i + 2] ?? '')) value = '?';
    if (!/^[-+*%&|^!~<>=?:;,.(){}[\]]$/.test(value) && value.length === 1) fail(`unexpected character ${JSON.stringify(c)}`);
    const previous = tokens.at(-1), before = tokens.at(-2);
    // Operand position never starts with `<`: that is JSX or a type argument, not JavaScript.
    if (value.startsWith('<') && slash === 'regex') fail('JSX or type syntax');
    const word = previous?.type === 'id' && !previous.dot ? previous.value : '';
    let opened;
    if (value === '(') opened = HEADER.has(word) || (word === 'await' && before?.value === 'for' && !before.dot) ? (CONTROL.has(word) || word === 'await' ? 'control(' : 'header(') : '(';
    else if (value === '[') opened = '[';
    else if (value === '{') {
      const statement = !previous || punctuation(previous, '}') || punctuation(previous, '{') || (punctuation(previous, ';') && (!stack.length || BRACES.has(stack.at(-1))));
      const block = previous?.header || BLOCK_WORDS.has(word) || punctuation(previous, '=>') || statement;
      opened = body?.depth === stack.length ? body.kind : block ? 'block' : word === 'default' || positionAfter(previous, stack) === 'expression' ? 'object' : '{';
      if (body?.depth === stack.length) body = null;
    }
    let closing, header = false;
    if (value === ')' || value === ']' || value === '}') {
      closing = stack.pop();
      if (value === '}' && closing === '${') { template(i + 1); continue; }
      header = closing === 'control(' || closing === 'header(';
      if (!(value === ')' ? closing === '(' || header : value === ']' ? closing === '[' : BRACES.has(closing))) fail(`unbalanced ${value}`);
    }
    push('p', value, i + value.length);
    if (header) tokens.at(-1).header = true;
    if (opened) stack.push(opened);
    slash = value === ')' ? (closing === 'control(' ? 'regex' : 'div') : value === ']' ? 'div' : value === '}' ? BODY_SLASH[closing] : value === '++' || value === '--' ? 'div' : 'regex';
  }
  if (stack.length) fail('unbalanced brackets at end of file');
  return tokens;
}
