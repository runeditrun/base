import { sqlTokens } from '../../modules/deploy-kit/sql-tokens.mjs';

// A static model of D1's "VIEWs and/or subqueries nested too deep" counter: the
// FROM-clause items of a statement (tables, CTE and view references, FROM
// subqueries, table-valued functions) with every CTE and view reference
// expanded in place. A recursive CTE's reference to itself is not expanded.
// It matched real D1 on every K21 probe and product statement.
const CLAUSE_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'RETURNING', 'SET', 'VALUES', 'SELECT']);

export const tokenize = sql => sqlTokens(sql).map(token => token.kind === 'word' ? { ...token, word: token.value.toUpperCase() } : token);
const sym = (token, char) => token?.kind === 'symbol' && token.value === char;
const is = (token, word) => token?.word === word;
const isSubquery = (t, i) => sym(t[i], '(') && ['SELECT', 'WITH', 'VALUES'].includes(t[i + 1]?.word);

function matching(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (sym(t[i], '(')) depth++;
    else if (sym(t[i], ')') && !--depth) return i;
  }
  throw new Error('unbalanced parentheses');
}

// t[i] is WITH. Returns the scope its definitions make and where the statement resumes.
function readWith(t, i, scope) {
  i++;
  if (is(t[i], 'RECURSIVE')) i++;
  const local = { ...scope };
  for (;;) {
    const name = t[i]?.value?.toLowerCase();
    if (name === undefined) throw new Error('WITH without a name');
    i++;
    if (sym(t[i], '(')) i = matching(t, i) + 1;
    if (!is(t[i], 'AS')) throw new Error(`expected AS after the CTE name ${name}`);
    i++;
    if (is(t[i], 'NOT')) i++;
    if (is(t[i], 'MATERIALIZED')) i++;
    const end = matching(t, i);
    local[name] = { t, a: i + 1, b: end, scope: local };
    i = end + 1;
    if (!sym(t[i], ',')) return { i, scope: local };
    i++;
  }
}

// One entry's count does not depend on the path to it unless it ran into a
// reference on that path, so counts are kept for the entries that did not.
const memo = new WeakMap();
function expand(entry, ctx, stack) {
  if (stack.includes(entry)) { ctx.blocked.add(entry); return 0; }
  if (memo.has(entry)) return memo.get(entry);
  const outer = ctx.blocked;
  ctx.blocked = new Set();
  const n = count(ctx, entry.t, entry.a, entry.b, entry.scope, [...stack, entry]);
  ctx.blocked.delete(entry);
  if (!ctx.blocked.size) memo.set(entry, n);
  for (const blocker of outer) ctx.blocked.add(blocker);
  return n;
}

// Items in t[a, b). Each paren level keeps its own FROM state: a parenthesised
// join group is its own list, and a function call's commas are not items.
function count(ctx, t, a, b, scope, stack) {
  let total = 0;
  const levels = [{ inFrom: false, expectItem: false }];
  for (let i = a; i < b; i++) {
    const token = t[i], level = levels[levels.length - 1];
    if (is(token, 'WITH') && !sym(t[i - 1], '.')) {
      const read = readWith(t, i, scope);
      scope = read.scope;
      i = read.i - 1;
      continue;
    }
    if (isSubquery(t, i)) {
      const end = matching(t, i);
      total += count(ctx, t, i + 1, end, scope, stack);
      if (level.expectItem) { total++; level.expectItem = false; }
      i = end;
      continue;
    }
    if (sym(token, '(')) {
      levels.push({ inFrom: level.expectItem, expectItem: level.expectItem });
      level.expectItem = false;
      continue;
    }
    if (sym(token, ')')) { if (levels.length > 1) levels.pop(); continue; }
    if ((is(token, 'FROM') && !is(t[i - 1], 'DISTINCT')) || is(token, 'JOIN')) {
      level.expectItem = true;
      if (is(token, 'FROM')) level.inFrom = true;
      continue;
    }
    if (sym(token, ',') && level.inFrom) { level.expectItem = true; continue; }
    if (token.word && CLAUSE_END.has(token.word)) level.inFrom = false;
    if (level.expectItem && (token.word || token.kind === 'identifier')) {
      level.expectItem = false;
      total++;
      const entry = scope[token.value.toLowerCase()];
      if (entry) total += expand(entry, ctx, stack);
      // A table-valued function: its arguments can hold subqueries.
      if (sym(t[i + 1], '(')) {
        const end = matching(t, i + 1);
        total += count(ctx, t, i + 2, end, scope, stack);
        i = end;
      }
    }
  }
  return total;
}

/** The view scope for fromItems: `views` is [{ name, select }], each select the
 * view's own SELECT text. A view expands wherever a statement reads it. */
export function viewScope(views) {
  const scope = {};
  for (const { name, select } of views) {
    const t = tokenize(select);
    scope[name.toLowerCase()] = { t, a: 0, b: t.length, scope };
  }
  return scope;
}

/** The FROM items of one statement, with CTEs and the given views expanded. */
export function fromItems(sql, scope = {}, tokens = tokenize(sql)) {
  return count({ blocked: new Set() }, tokens, 0, tokens.length, scope, []);
}
