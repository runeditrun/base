import { tokenize } from './from-items.mjs';

// SQLite's expression depth is measured through SELECT-shaped parts. A SELECT or
// VALUES is its own part. A DML statement is read as the SELECTs its
// expressions would form, each over its target table:
//   INSERT   its SELECT or VALUES; an upsert's DO UPDATE SET right-hand sides
//            and WHERE, with `excluded.` read as the target table itself
//   UPDATE   the SET right-hand sides, FROM, WHERE and RETURNING
//   DELETE   its WHERE and RETURNING
const sym = (token, char) => token?.kind === 'symbol' && token.value === char;
const is = (token, word) => token?.word === word;

// Index of the first top-level `word` in t[from, until), or -1.
function topLevel(t, from, word, until = t.length) {
  let depth = 0;
  for (let i = from; i < until; i++) {
    if (sym(t[i], '(')) depth++;
    else if (sym(t[i], ')')) depth--;
    else if (!depth && is(t[i], word)) return i;
  }
  return -1;
}
function splitTop(t, a, b) {
  const parts = [];
  let depth = 0, start = a;
  for (let i = a; i < b; i++) {
    if (sym(t[i], '(')) depth++;
    else if (sym(t[i], ')')) depth--;
    else if (!depth && sym(t[i], ',')) { parts.push(t.slice(start, i)); start = i + 1; }
  }
  parts.push(t.slice(start, b));
  return parts;
}
const skipParens = (t, i) => {
  let depth = 0;
  for (; i < t.length; i++) {
    if (sym(t[i], '(')) depth++;
    else if (sym(t[i], ')') && !--depth) return i + 1;
  }
  return i;
};

export function dmlParts(sql, tokens = tokenize(sql)) {
  const t = tokens, text = list => list.length ? sql.slice(list[0].start, list[list.length - 1].end) : '';
  // `[schema.]name [AS alias]`: the target table as a FROM item, and where it ends.
  const target = i => {
    let name = text([t[i]]);
    i++;
    if (sym(t[i], '.')) { name += `.${text([t[i + 1]])}`; i += 2; }
    let alias = '';
    if (is(t[i], 'AS')) { alias = text([t[i + 1]]); i += 2; }
    return { item: alias ? `${name} AS ${alias}` : name, alias: alias || name, next: i };
  };
  let start = 0;
  if (is(t[0], 'WITH')) {
    let depth = 0;
    for (start = 1; start < t.length; start++) {
      if (sym(t[start], '(')) depth++;
      else if (sym(t[start], ')')) depth--;
      else if (!depth && ['SELECT', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(t[start].word) && sym(t[start - 1], ')')) break;
    }
  }
  const prefix = text(t.slice(0, start)), main = t[start]?.word;
  const selectOver = (list, item, where, returning = []) => `${prefix} SELECT ${list.join(', ')}${returning.length ? `, ${text(returning)}` : ''} FROM ${item}${where.length ? ` WHERE ${text(where)}` : ''}`;
  if (main === 'INSERT' || main === 'REPLACE') {
    const into = topLevel(t, start, 'INTO'), into1 = target(into + 1);
    let j = into1.next;
    if (sym(t[j], '(')) j = skipParens(t, j);
    const conflicts = [];
    for (let x = j; x < t.length - 1; x++) if (!sym(t[x], '(') && is(t[x], 'ON') && is(t[x + 1], 'CONFLICT')) conflicts.push(x);
    const returning = topLevel(t, j, 'RETURNING'), end = returning >= 0 ? returning : t.length;
    const parts = [];
    const bodyEnd = conflicts[0] ?? end;
    if (!is(t[j], 'DEFAULT')) parts.push(`${prefix} ${text(t.slice(j, bodyEnd))}`);
    const excluded = part => part.replace(/\bexcluded\s*\./gi, `${into1.alias}.`);
    conflicts.forEach((at, n) => {
      const until = conflicts[n + 1] ?? end, doAt = topLevel(t, at, 'DO', until);
      // The conflict target's own WHERE is an expression too.
      const targetWhere = topLevel(t, at, 'WHERE', doAt >= 0 ? doAt : until);
      if (targetWhere >= 0) parts.push(excluded(selectOver(['1'], into1.item, t.slice(targetWhere + 1, doAt >= 0 ? doAt : until))));
      const set = doAt >= 0 && is(t[doAt + 1], 'UPDATE') ? topLevel(t, doAt, 'SET', until) : -1;
      if (set < 0) return;
      const where = topLevel(t, set, 'WHERE', until);
      const right = splitTop(t, set + 1, where >= 0 ? where : until).map(assignment => text(assignment.slice(assignment.findIndex(x => sym(x, '=')) + 1)));
      parts.push(excluded(selectOver(right, into1.item, where >= 0 ? t.slice(where + 1, until) : [])));
    });
    if (returning >= 0) parts.push(`SELECT ${text(t.slice(returning + 1))} FROM ${into1.item}`);
    return parts;
  }
  if (main === 'UPDATE') {
    let j = start + 1;
    if (is(t[j], 'OR')) j += 2;
    const table = target(j), set = topLevel(t, table.next, 'SET');
    const returning = topLevel(t, set, 'RETURNING'), end = returning >= 0 ? returning : t.length;
    const where = topLevel(t, set, 'WHERE', end), from = topLevel(t, set, 'FROM', where >= 0 ? where : end);
    const assignments = from >= 0 ? from : where >= 0 ? where : end;
    const right = splitTop(t, set + 1, assignments).map(assignment => text(assignment.slice(assignment.findIndex(x => sym(x, '=')) + 1)));
    const items = from >= 0 ? `${table.item}, ${text(t.slice(from + 1, where >= 0 ? where : end))}` : table.item;
    return [selectOver(right, items, where >= 0 ? t.slice(where + 1, end) : [], returning >= 0 ? t.slice(returning + 1) : [])];
  }
  if (main === 'DELETE') {
    const from = topLevel(t, start, 'FROM'), table = target(from + 1);
    const returning = topLevel(t, from, 'RETURNING'), end = returning >= 0 ? returning : t.length;
    const where = topLevel(t, from, 'WHERE', end);
    return [selectOver(['1'], table.item, where >= 0 ? t.slice(where + 1, end) : [], returning >= 0 ? t.slice(returning + 1) : [])];
  }
  return [sql];
}
