import { sqlTokens } from '../../modules/deploy-kit/sql-tokens.mjs';

// Compiles a size-check.json shape and one size into the ordered statements that build it: each table is chunked
// INSERT … SELECT over a recursive row sequence, so a database of millions of rows is built inside SQLite with no
// row crossing the process boundary, and the schema's own triggers derive the rest. Pure: no file, no database.
// Exported as @runeditrun/rer/size-fixture so the fleet's real-D1 runner seeds exactly the statements rer runs.
//
// Names an expression may use: n (row number from 1), p (the parent's row number from 1), k (the index from 0
// inside a jsonArray item), and the parameters :now, :owner_email and :size. D1 binds only ? and ?NNN, so each
// parameter is found as a token outside quotes and comments and rewritten to ?NNN.

export const sizes = Object.freeze(['small', 'large']);
const known = new Set(['now', 'owner_email', 'size']);

/** A declaration that cannot be compiled, naming the table and, when it is one expression, the column. */
export class FixtureError extends Error {
 constructor(message, { table, column } = {}) {
  super(`${table ? `${table}${column ? `.${column}` : ''}: ` : ''}${message}`);
  this.name = 'FixtureError';
  this.table = table;
  this.column = column;
 }
}

// Rewrites each :now, :owner_email and :size outside quotes and comments to ?NNN. `order` lists the parameter names
// in the order of their numbers (?1 is order[0]) and is shared by every expression of one statement.
function bind(sql, order, where) {
 let tokens;
 try { tokens = sqlTokens(sql); }
 catch { throw new FixtureError('has an unterminated quote or comment', where); }
 let out = '', from = 0;
 for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token.kind !== 'symbol' || !'?:@$'.includes(token.value)) continue;
  const next = tokens[i + 1], name = next?.kind === 'word' && next.start === token.end ? next.value : undefined;
  if (token.value !== ':' || !known.has(name)) throw new FixtureError(`uses ${name ? token.value + name : `"${token.value}"`}, which is not a parameter; the parameters are :now, :owner_email and :size`, where);
  if (!order.includes(name)) order.push(name);
  out += sql.slice(from, token.start) + `?${order.indexOf(name) + 1}`;
  from = next.end;
  i++;
 }
 return out + sql.slice(from);
}

// A column's SQL. A jsonArray is a correlated recursive-CTE subquery: k runs from 0 to length - 1, and an empty
// length gives [].
function columnSql(value, order, where) {
 if (typeof value === 'string') return bind(value, order, where);
 const length = bind(value.jsonArray.length, order, where), item = bind(value.jsonArray.item, order, where);
 return `(WITH RECURSIVE rer_k(k) AS (SELECT 0 WHERE 0 < (${length}) UNION ALL SELECT k + 1 FROM rer_k WHERE k + 1 < (${length})) SELECT json_group_array(${item}) FROM rer_k)`;
}

const plainRows = (rows, size) => typeof rows === 'number' ? rows : rows[size];

// The runs of row numbers a table is built in, each with the SQL of its parent row number p. A histogram takes its
// parents from row 1, those with the most children first.
function runs(table, total, size) {
 const chunk = table.chunk ?? 10_000, split = (first, last, p) => {
  const found = [];
  for (let a = first; a <= last; a += chunk) found.push({ first: a, last: Math.min(last, a + chunk - 1), p });
  return found;
 };
 const parent = table.parent;
 if (parent?.histogram) {
  const buckets = Object.entries(parent.histogram).map(([children, parents]) => [Number(children), parents]).sort((a, b) => b[0] - a[0]);
  const sum = buckets.reduce((all, [children, parents]) => all + children * parents, 0);
  if (sum !== total) throw new FixtureError(`its histogram builds ${sum.toLocaleString('en-US')} rows but rows is ${total.toLocaleString('en-US')} at the ${size} size; make the sums equal`, { table: table.table });
  const found = [];
  let rows = 0, parents = 0;
  for (const [children, count] of buckets) {
   found.push(...split(rows + 1, rows + children * count, `${parents + 1} + (n - ${rows + 1}) / ${children}`));
   rows += children * count;
   parents += count;
  }
  return { runs: found, parents };
 }
 if (parent) return { runs: split(1, total, `(n - 1) / ${parent.per} + 1`), parents: Math.ceil(total / parent.per) };
 return { runs: split(1, total, 'NULL'), parents: 0 };
}

/**
 * The statements that build `size` ('small' or 'large') of a declaration's shape: `{ statements, parts, tables,
 * parameters }`. `statements` is `[{ name, sql, params }]` in the order to run them (the fleet runner's format);
 * `parts[i]` says what statements[i] builds ({ kind: 'rows', table, first, last } or { kind: 'after', index });
 * `tables` is each table's declared row count at this size; `parameters` lists the names its expressions use.
 * `now` is the run's start in Unix milliseconds and `ownerEmail` the owner persona's email.
 */
export function compileFixture(declaration, size, { now, ownerEmail } = {}) {
 if (!sizes.includes(size)) throw new FixtureError(`size must be ${sizes.join(' or ')}, not ${JSON.stringify(size)}`);
 const values = { now, owner_email: ownerEmail, size }, statements = [], parts = [], tables = [], used = new Set();
 const rowsOf = new Map();
 const bound = order => order.map(name => {
  used.add(name);
  if (values[name] === undefined) throw new FixtureError(`needs :${name}, which this run has no value for`);
  return values[name];
 });
 for (const table of declaration.shape.tables) {
  const total = plainRows(table.rows, size), where = { table: table.table }, order = [];
  if (table.parent && !rowsOf.has(table.parent.table)) throw new FixtureError(`its parent table ${table.parent.table} must be listed earlier in shape.tables`, where);
  const columns = Object.keys(table.values), expressions = columns.map(column => columnSql(table.values[column], order, { table: table.table, column }));
  const params = bound(order), { runs: chunks, parents } = runs(table, total, size);
  if (table.parent && parents > rowsOf.get(table.parent.table)) throw new FixtureError(`its rows reach parent row ${parents.toLocaleString('en-US')} of ${table.parent.table}, which has ${rowsOf.get(table.parent.table).toLocaleString('en-US')} rows at the ${size} size`, where);
  for (const { first, last, p } of chunks) {
   statements.push({
    name: `${size}:${table.table}:${first}-${last}`,
    sql: `INSERT INTO ${table.table}(${columns.map(column => `"${column}"`).join(',')}) WITH RECURSIVE rer_seq(n) AS (SELECT ${first} UNION ALL SELECT n + 1 FROM rer_seq WHERE n < ${last}), rer_rows(n, p) AS (SELECT n, ${p} FROM rer_seq)\nSELECT ${expressions.join(',\n')}\nFROM rer_rows`,
    params: [...params],
   });
   parts.push({ kind: 'rows', table: table.table, first, last });
  }
  rowsOf.set(table.table, total);
  tables.push({ table: table.table, rows: total });
 }
 (declaration.shape.after ?? []).forEach((statement, index) => {
  const order = [], sql = bind(statement, order, {});
  statements.push({ name: `${size}:after:${index + 1}`, sql, params: bound(order) });
  parts.push({ kind: 'after', index: index + 1 });
 });
 return { statements, parts, tables, parameters: [...used] };
}

/** The parameter names a declaration's expressions use, for deciding what a run must prepare (the owner, for :owner_email). */
export function fixtureParameters(declaration) {
 const names = new Set(), order = [];
 const scan = (sql, where) => { order.length = 0; bind(sql, order, where); order.forEach(name => names.add(name)); };
 for (const table of declaration.shape.tables) for (const [column, value] of Object.entries(table.values)) {
  const where = { table: table.table, column };
  if (typeof value === 'string') scan(value, where); else { scan(value.jsonArray.length, where); scan(value.jsonArray.item, where); }
 }
 for (const statement of declaration.shape.after ?? []) scan(statement, {});
 return names;
}

/** The column(s) SQLite names in a failure message ("NOT NULL constraint failed: items.label"), or undefined. */
export function failureColumn(message) {
 const failed = /constraint failed: ([^:]+)/.exec(message)?.[1];
 const named = failed ? [...failed.matchAll(/\w+\.(\w+)/g)].map(match => match[1]) : [];
 return named.length ? named.join(', ') : /has no column named (\w+)/.exec(message)?.[1] ?? /no such column: (?:\w+\.)?(\w+)/.exec(message)?.[1];
}
