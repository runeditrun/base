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
export function d1Preflight(sql, values = [], tableColumns) {
  const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value).length
    : value instanceof ArrayBuffer ? value.byteLength : ArrayBuffer.isView(value) ? value.byteLength
    : Array.isArray(value) ? value.length : 0;
  const limit = (name, maximum, measured) => {
    if (measured > maximum) throw new Error(`D1 limit exceeded: ${name} maximum ${maximum}, measured ${measured}`);
  };
  limit('SQL statement bytes', d1NativeLimits.sqlLength, bytes(sql));
  limit('bound parameters', d1NativeLimits.variableNumber, values.length);
  for (const value of values) limit('string or BLOB bytes', d1NativeLimits.length, bytes(value));
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
    if (token.value !== undefined) limit('string or BLOB bytes', d1NativeLimits.length, bytes(token.value));
    tokens.push(token);
  }
  limit('bound parameters', d1NativeLimits.variableNumber, bindIndex);
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
  const projectedColumns = new Map();
  const identifier = token => {
    const text = token?.text ?? '';
    return /^["'`\[]/.test(text) ? text.slice(1,-1).replace(/(["'`])\1/g, '$1') : text;
  };
  const tableAt = index => tokens[index + 1]?.text === '.' ? index + 2 : index;
  const key = name => name.replace(/[A-Z]/g, char => char.toLowerCase());
  const existing = name => projectedColumns.has(key(name)) ? projectedColumns.get(key(name)) : tableColumns?.(name);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], close = pairs.get(i + 1);
    const call = close !== undefined && /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(token.text) && !structural.has(token.word);
    // A table name following CREATE TABLE or INSERT INTO is not a function.
    const table = ['TABLE', 'INTO', 'EXISTS', 'REFERENCES', 'VIEW', 'USING'].includes(tokens[i - 1]?.word)
      || tokens[i - 1]?.text === '.' && ['TABLE', 'INTO', 'EXISTS', 'REFERENCES', 'VIEW'].includes(tokens[i - 3]?.word)
      || tokens[i - 1]?.word === 'ON' && tokens.slice(0, i).some(t => t.word === 'INDEX')
      || tokens[close + 1]?.word === 'AS' && ['(', 'MATERIALIZED', 'NOT'].includes(tokens[close + 2]?.word);
    if (call && !table) {
      const args = split(i + 2, close);
      limit('SQL function arguments', d1NativeLimits.functionArg, args.length);
      if (['LIKE', 'GLOB'].includes(token.word)) limit('LIKE or GLOB pattern bytes', d1NativeLimits.likePatternLength, bytes(tokens[args[0]?.[0]]?.value));
    }
    if (['LIKE', 'GLOB'].includes(token.word) && tokens[i + 1]?.text !== '(') limit('LIKE or GLOB pattern bytes', d1NativeLimits.likePatternLength, bytes(tokens[i + 1]?.value));
    if (token.word === 'ALTER' && tokens[i + 1]?.word === 'TABLE') {
      const nameIndex = tableAt(i + 2), name = identifier(tokens[nameIndex]), count = existing(name);
      const action = tokens[nameIndex + 1]?.word;
      if (count !== undefined && action === 'ADD') { limit('columns per table', d1NativeLimits.column, count + 1); projectedColumns.set(key(name), count + 1); }
      if (count !== undefined && action === 'DROP') projectedColumns.set(key(name), count - 1);
      if (count !== undefined && action === 'RENAME' && tokens[nameIndex + 2]?.word === 'TO') projectedColumns.set(key(identifier(tokens[nameIndex + 3])), count);
    }
    if (token.word === 'TABLE' && tokens[i - 1]?.word !== 'VIRTUAL' && tokens.slice(Math.max(0, i - 2), i).some(t => t.word === 'CREATE')) {
      let open = i + 1;
      while (open < tokens.length && tokens[open].text !== '(') open++;
      const end = pairs.get(open);
      if (end !== undefined) {
        const columns = split(open + 1, end).filter(([start]) => !['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(tokens[start].word));
        limit('columns per table', d1NativeLimits.column, columns.length);
        const name = identifier(tokens[tableAt(i + (tokens[i + 1]?.word === 'IF' ? 4 : 1))]);
        projectedColumns.set(key(name), tokens[i + 1]?.word === 'IF' ? existing(name) ?? columns.length : columns.length);
      }
    }
  }
  // Estimate expression-tree height with precedence, preserving left-associative
  // chains. SQL clause boundaries reset trees; parentheses do not add a node.
  const precedence = new Map([['OR', 1], ['AND', 2], ['=', 3], ['==', 3], ['!=', 3], ['<>', 3], ['IS', 3], ['LIKE', 3], ['GLOB', 3], ['IN', 3], ['<', 4], ['>', 4], ['<=', 4], ['>=', 4], ['|', 5], ['&', 5], ['<<', 5], ['>>', 5], ['+', 6], ['-', 6], ['*', 7], ['/', 7], ['%', 7], ['||', 8], ['->', 8], ['->>', 8]]);
  let maximumDepth = 0;
  function scan(start, end) {
    let heights = [], operators = [], expect = true, localDepth = 1, unary = 0;
    const reduce = () => { const right = heights.pop() ?? 1, left = heights.pop() ?? 1; operators.pop(); heights.push(1 + Math.max(left, right)); };
    const flush = () => { while (operators.length) reduce(); localDepth = Math.max(localDepth, ...heights); maximumDepth = Math.max(maximumDepth, localDepth); heights = []; expect = true; unary = 0; };
    const atom = height => { heights.push(height + unary); unary = 0; expect = false; };
    for (let i = start; i < end; i++) {
      const token = tokens[i];
      if (expect && ['NOT', '+', '-', '~'].includes(token.word)) { unary++; continue; }
      if (token.text === '(' && pairs.has(i)) {
        const close = pairs.get(i), child = scan(i + 1, close);
        const previous = tokens[i - 1];
        const call = previous && /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(previous.text) && !structural.has(previous.word);
        const prefix = call && !expect ? Math.max(0, heights.pop() - 1) : 0;
        atom(child + (call ? 1 : 0) + prefix); i = close;
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
        atom(scan(i + 1, close) + 1); i = close;
      } else if (structural.has(token.word) || [',', ';'].includes(token.text)) flush();
      else if (token.text !== ')' && token.text !== '.') atom(1);
    }
    flush(); return localDepth;
  }
  scan(0, tokens.length);
  let caseDepth = 0;
  for (const token of tokens) { if (token.word === 'CASE') maximumDepth = Math.max(maximumDepth, ++caseDepth + 1); if (token.word === 'END') caseDepth--; }
  limit('expression depth estimate (OBSERVED-NOT-DOCUMENTED)', d1NativeLimits.exprDepth, maximumDepth);
}

/** Check computed result values before exposing a statement's results. Drivers
 * call this inside their transaction so a failed RETURNING also rolls back. */
export function d1ResultPreflight(rows) {
  for (const row of rows) for (const value of Object.values(row)) {
    const size = typeof value === 'string' ? new TextEncoder().encode(value).length
      : value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value.byteLength
      : Array.isArray(value) ? value.length : 0;
    if (size > d1NativeLimits.length) throw new Error(`D1 limit exceeded: string or BLOB bytes maximum ${d1NativeLimits.length}, measured ${size}`);
  }
}

/** Shared encoded-record measurement. Node installs connection-local BEFORE
 * triggers. Workerd forbids those triggers, so it checks uncommitted rows
 * inside the existing D1 transaction and throws before that transaction commits.
 */
export function createD1RowGuard() {
  const quote = name => '"' + name.replaceAll('"', '""') + '"';
  const sum = terms => terms.length === 0 ? '0' : terms.length === 1 ? terms[0]
    : `(${sum(terms.slice(0, terms.length >> 1))}+${sum(terms.slice(terms.length >> 1))})`;
  const state = new WeakMap();
  const key = name => name.replace(/[A-Z]/g, char => char.toLowerCase());
  return function guardD1Rows(db, prepare, exec, query, schemaEdit = false) {
    // Internal TEMP triggers must not participate in application schema edits.
    // SQLite validates every trigger when a column is dropped, even though
    // these guards will be regenerated against the resulting schema.
    if (exec && schemaEdit) {
      for (const name of state.get(db)?.names ?? []) exec(`DROP TRIGGER IF EXISTS temp.${quote(name)}`);
      state.delete(db);
      return;
    }
    const version = exec ? prepare('PRAGMA main.schema_version').get().schema_version : undefined;
    if (exec && state.get(db)?.version === version) return;
    const tables = prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
    let touched;
    if (query) {
      // Read only the tables this statement and its SQL triggers can change.
      // Quoted strings are opaque; quoted table identifiers are decoded only
      // after a mutation keyword. This avoids rescanning unrelated large stores.
      const targets = sql => {
        const tokens = [...sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_\u0080-\uFFFF][a-zA-Z_0-9$\u0080-\uFFFF]*|[.;]/g)]
          .map(match => match[0]).filter(text => !text.startsWith('--') && !text.startsWith('/*'));
        const names = [];
        const word = index => /^[a-zA-Z_]/.test(tokens[index] ?? '') ? tokens[index].toUpperCase() : '';
        for (let i = 0; i < tokens.length; i++) {
          if (!['INSERT','UPDATE','DELETE','REPLACE'].includes(word(i))) continue;
          let next = i + 1;
          if (word(next) === 'OR') next += 2;
          if (word(i) === 'DELETE') { if (word(next) !== 'FROM') continue; next++; }
          else if (word(i) !== 'UPDATE') { if (word(next) !== 'INTO') continue; next++; }
          if (tokens[next + 1] === '.') next += 2;
          const name = tokens[next];
          if (!name || /^[.;]$/.test(name)) continue;
          names.push(/^["'`\[]/.test(name) ? name.slice(1,-1).replace(/(["'`])\1/g, '$1') : name);
        }
        return names;
      };
      touched = new Set(targets(query).map(key));
      const triggers = prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger'").all();
      let previous;
      do {
        previous = touched.size;
        for (const trigger of triggers) if (touched.has(key(trigger.tbl_name))) for (const name of targets(trigger.sql)) touched.add(key(name));
      } while (previous !== touched.size);
      for (const table of tables) if (touched.has(key(table.name)) && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql))
        for (const shadow of tables) if (key(shadow.name).startsWith(key(table.name) + '_')) touched.add(key(shadow.name));
    }
    const names = [];
    for (const table of tables) {
      if (touched && !touched.has(key(table.name))) continue;
      // Cloudflare owns reserved metadata; its authorizer forbids user access.
      if (table.name.startsWith('_cf_')) continue;
      // Virtual indexes store their data in ordinary shadow tables below.
      if (/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql)) continue;
      const columns = prepare(`PRAGMA ${exec ? 'main.table_xinfo' : 'table_info'}(${quote(table.name)})`).all().filter(column => column.hidden !== 2);
      if (columns.length > d1NativeLimits.column) throw new Error(`D1 limit exceeded: columns per table maximum ${d1NativeLimits.column}, measured ${columns.length}`);
      const primary = columns.filter(column => column.pk);
      // The primary-key index distinguishes stored INTEGER keys (including
      // inline DESC and WITHOUT ROWID) from SQLite's rowid alias.
      const integerPrimary = primary.length === 1 && primary[0].type.toUpperCase() === 'INTEGER';
      const rowidAlias = integerPrimary && !prepare(`PRAGMA index_list(${quote(table.name)})`).all().some(index => index.origin === 'pk') ? primary[0].name : undefined;
      const body = [], header = [], projection = [];
      for (const [index, column] of columns.entries()) {
        const value = `v${index}`, length = `length(CAST(${value} AS BLOB))`, type = `typeof(${value})`;
        projection.push(`${column.name === rowidAlias ? 'NULL' : `${exec ? 'NEW.' : ''}${quote(column.name)}`} AS ${value}`);
        body.push(`CASE WHEN ${value} IS NULL THEN 0 WHEN ${type} IN ('integer','real') THEN CASE WHEN ${type}='real' AND ${value}<>CAST(${value} AS INTEGER) THEN 8 WHEN ${value} IN (0,1) THEN 0 WHEN ${value} BETWEEN -128 AND 127 THEN 1 WHEN ${value} BETWEEN -32768 AND 32767 THEN 2 WHEN ${value} BETWEEN -8388608 AND 8388607 THEN 3 WHEN ${value} BETWEEN -2147483648 AND 2147483647 THEN 4 WHEN ${value} BETWEEN -140737488355328 AND 140737488355327 THEN 6 ELSE 8 END ELSE ${length} END`);
        header.push(`CASE WHEN ${type} IN ('text','blob') THEN CASE WHEN ${length}<=57 THEN 1 WHEN ${length}<=8185 THEN 2 WHEN ${length}<=1048569 THEN 3 ELSE 4 END ELSE 1 END`);
      }
      // Aliases keep internal measurement below the SQL budget at 100 columns;
      // balanced sums keep its own tree below the observed depth boundary.
      const source = `SELECT ${projection.join(',')}${exec ? '' : ` FROM ${quote(table.name)}`}`;
      const sizes = `SELECT ${sum(body)} AS payload,${sum(header)} AS header FROM (${source})`;
      const measured = `SELECT payload+header+CASE WHEN header<127 THEN 1 ELSE 2 END AS measured FROM (${sizes})`;
      if (!exec) {
        const check = `SELECT measured FROM (${measured}) WHERE measured>${d1NativeLimits.length} LIMIT 1`;
        const bytes = sql => new TextEncoder().encode(sql).length;
        if (bytes(check) <= d1NativeLimits.sqlLength) {
          const oversized = prepare(check).get();
          if (oversized) throw new Error(`D1 limit exceeded: table row bytes maximum ${d1NativeLimits.length}, measured ${oversized.measured}`);
        } else {
          // Scan the same physical table order for each column chunk. NOT
          // INDEXED prevents a projection-dependent covering-index choice;
          // WITHOUT ROWID tables retain their primary-key storage order.
          // Only numeric partial sizes leave SQLite, never cell contents.
          const partial = (start, end) => `SELECT ${sum(body.slice(start,end))} AS payload,${sum(header.slice(start,end))} AS header FROM (SELECT ${projection.slice(start,end).join(',')} FROM ${quote(table.name)} NOT INDEXED)`;
          const totals = [];
          for (let start = 0; start < columns.length;) {
            let end = start + 1;
            while (end < columns.length && bytes(partial(start,end+1)) <= d1NativeLimits.sqlLength) end++;
            const sql = partial(start,end);
            d1Preflight(sql);
            const rows = prepare(sql).all();
            for (const [index,row] of rows.entries()) {
              const total = totals[index] ??= { payload:0, header:0 };
              total.payload += row.payload; total.header += row.header;
            }
            start = end;
          }
          for (const {payload,header} of totals) {
            const size = payload + header + (header < 127 ? 1 : 2);
            if (size > d1NativeLimits.length) throw new Error(`D1 limit exceeded: table row bytes maximum ${d1NativeLimits.length}, measured ${size}`);
          }
        }
        continue;
      }
      for (const action of ['INSERT', 'UPDATE']) {
        const rawName = `rer_d1_row_${action}_${table.name}`;
        names.push(rawName);
        const name = quote(rawName);
        exec(`DROP TRIGGER IF EXISTS temp.${name}`);
        exec(`CREATE TEMP TRIGGER ${name} BEFORE ${action} ON main.${quote(table.name)} BEGIN SELECT CASE WHEN measured>${d1NativeLimits.length} THEN RAISE(ABORT,'D1 limit exceeded: table row bytes maximum ${d1NativeLimits.length}, measured '||measured) END FROM (${measured}); END`);
      }
    }
    if (exec) state.set(db, {version,names});
  };
}

export const guardD1Rows = createD1RowGuard();

/** Driver-supplied schema access keeps ALTER admission before execution. */
export function d1ColumnCount(table, rows, pragma = 'table_info') {
  return rows(`PRAGMA ${pragma}("${table.replaceAll('"', '""')}")`).length || undefined;
}
