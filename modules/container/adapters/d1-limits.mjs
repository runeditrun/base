/** Cloudflare D1 per-query limits, supplied from the platform limits page
 * (updated 24 Oct 2026). Expression depth 100 is OBSERVED-NOT-DOCUMENTED:
 * native D1 rejected a concatenation tree of depth 101 on 27 Oct 2026.
 * Node 22.20.0 ignores DatabaseSync limits options: preflight is mandatory.
 * Queries per Worker invocation (Paid 1000, Free 50, batch counts once) and
 * the 30 second query deadline are NOT-ENFORCEABLE-LOCALLY here: a database
 * connection has neither the invocation boundary nor the provider scheduler.
 */
export const d1NativeLimits = Object.freeze({ length: 2_000_000, sqlLength: 100_000,
  column: 100, variableNumber: 100, functionArg: 32, likePatternLength: 50, exprDepth: 100 });

/** ENFORCED-BY-PREFLIGHT. Self-contained so workerd can run the same code.
 * Depth is an estimate, not a complete SQLite parser. Parentheses, function
 * calls, operator chains and CASE bodies are traversed without evaluating SQL.
 */
export function d1Preflight(sql, values = []) {
  const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value).length
    : value instanceof ArrayBuffer ? value.byteLength : ArrayBuffer.isView(value) ? value.byteLength
    : Array.isArray(value) ? value.length : 0;
  const limit = (name, maximum, measured) => {
    if (measured > maximum) throw new Error(`D1 limit exceeded: ${name} maximum ${maximum}, measured ${measured}`);
  };
  limit('SQL statement bytes', 100_000, bytes(sql));
  limit('bound parameters', 100, values.length);
  for (const value of values) limit('string or BLOB bytes', 2_000_000, bytes(value));
  const tokens = [];
  const pattern = /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|[xX]'(?:[0-9a-fA-F]{2})*'|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\?(?:\d+)?|[:@$][\w]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}_$]*|\|\||->>|->|<<|>>|<=|>=|<>|!=|==|[^\s]/gu;
  let bindIndex = 0;
  const names = new Map();
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    if (/^\s|^--|^\/\*/.test(text)) continue;
    const token = { text, word: text.toUpperCase(), value: undefined, parameter: false };
    if (text[0] === "'") token.value = text.slice(1, -1).replaceAll("''", "'");
    else if (/^[xX]'/.test(text)) token.value = new Uint8Array((text.length - 3) / 2);
    else if (/^[?:@$]/.test(text)) {
      token.parameter = true;
      let index;
      if (/^\?\d+$/.test(text)) index = Number(text.slice(1));
      else if (text === '?') index = bindIndex + 1;
      else { if (!names.has(text)) names.set(text, bindIndex + 1); index = names.get(text); }
      bindIndex = Math.max(bindIndex, index);
      token.value = values[index - 1];
    }
    if (token.value !== undefined) limit('string or BLOB bytes', 2_000_000, bytes(token.value));
    tokens.push(token);
  }
  limit('bound parameters', 100, bindIndex);
  const structural = new Set(['IN', 'VALUES', 'AS', 'SELECT', 'FROM', 'WHERE', 'ON', 'USING', 'OVER', 'FILTER', 'EXISTS', 'TABLE', 'CHECK', 'KEY', 'UNIQUE', 'REFERENCES', 'CONSTRAINT', 'BY', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IS', 'SET', 'RETURNING']);
  const pairs = new Map(), stack = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === '(') stack.push(i);
    if (tokens[i].text === ')' && stack.length) { const open = stack.pop(); pairs.set(open, i); }
  }
  const split = (start, end) => {
    const parts = []; let begin = start;
    for (let i = start; i < end; i++) {
      if (tokens[i].text === '(' && pairs.has(i)) i = pairs.get(i);
      else if (tokens[i].text === ',') { parts.push([begin, i]); begin = i + 1; }
    }
    if (begin < end) parts.push([begin, end]);
    return parts;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], close = pairs.get(i + 1);
    const call = close !== undefined && /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(token.text) && !structural.has(token.word);
    // A table name following CREATE TABLE or INSERT INTO is not a function.
    const table = ['TABLE', 'INTO'].includes(tokens[i - 1]?.word) || tokens[i - 1]?.word === 'EXISTS';
    if (call && !table) {
      const args = split(i + 2, close);
      limit('SQL function arguments', 32, args.length);
      if (['LIKE', 'GLOB'].includes(token.word)) limit('LIKE or GLOB pattern bytes', 50, bytes(tokens[args[0]?.[0]]?.value));
    }
    if (['LIKE', 'GLOB'].includes(token.word) && tokens[i + 1]?.text !== '(') limit('LIKE or GLOB pattern bytes', 50, bytes(tokens[i + 1]?.value));
    if (token.word === 'TABLE' && tokens.slice(Math.max(0, i - 2), i).some(t => t.word === 'CREATE')) {
      let open = i + 1;
      while (open < tokens.length && tokens[open].text !== '(') open++;
      const end = pairs.get(open);
      if (end !== undefined) {
        const columns = split(open + 1, end).filter(([start]) => !['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(tokens[start].word));
        limit('columns per table', 100, columns.length);
      }
    }
  }
  // Estimate expression-tree height with precedence, preserving left-associative
  // chains. SQL clause boundaries reset trees; parentheses do not add a node.
  const precedence = new Map([['OR', 1], ['AND', 2], ['=', 3], ['==', 3], ['!=', 3], ['<>', 3], ['IS', 3], ['LIKE', 3], ['GLOB', 3], ['IN', 3], ['<', 4], ['>', 4], ['<=', 4], ['>=', 4], ['|', 5], ['&', 5], ['<<', 5], ['>>', 5], ['+', 6], ['-', 6], ['*', 7], ['/', 7], ['%', 7], ['||', 8], ['->', 8], ['->>', 8]]);
  let maximumDepth = 0;
  function scan(start, end) {
    let heights = [], operators = [], expect = true, localDepth = 1;
    const reduce = () => { const right = heights.pop() ?? 1, left = heights.pop() ?? 1; operators.pop(); heights.push(1 + Math.max(left, right)); };
    const flush = () => { while (operators.length) reduce(); localDepth = Math.max(localDepth, ...heights); maximumDepth = Math.max(maximumDepth, localDepth); heights = []; expect = true; };
    for (let i = start; i < end; i++) {
      const token = tokens[i];
      if (token.text === '(' && pairs.has(i)) {
        const close = pairs.get(i), child = scan(i + 1, close);
        const previous = tokens[i - 1];
        const call = previous && /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(previous.text) && !structural.has(previous.word);
        if (call && !expect) heights.pop();
        heights.push(child + (call ? 1 : 0)); expect = false; i = close;
      } else if (precedence.has(token.word) && !expect) {
        const priority = precedence.get(token.word);
        while (operators.length && operators.at(-1) >= priority) reduce();
        operators.push(priority); expect = true;
      } else if (token.word === 'CASE') {
        let nesting = 1, close = i + 1;
        for (; close < end; close++) {
          if (tokens[close].word === 'CASE') nesting++;
          if (tokens[close].word === 'END' && --nesting === 0) break;
        }
        heights.push(scan(i + 1, close) + 1); expect = false; i = close;
      } else if (structural.has(token.word) || [',', ';'].includes(token.text)) flush();
      else if (token.text !== ')' && token.text !== '.') { heights.push(1); expect = false; }
    }
    flush(); return localDepth;
  }
  scan(0, tokens.length);
  let caseDepth = 0;
  for (const token of tokens) { if (token.word === 'CASE') maximumDepth = Math.max(maximumDepth, ++caseDepth + 1); if (token.word === 'END') caseDepth--; }
  limit('expression depth estimate (OBSERVED-NOT-DOCUMENTED)', 100, maximumDepth);
}
