import { expressionProblem } from './expression.mjs';
import { count, identifier, integer, isInt, isObject, keyed } from './validate-kit.mjs';

const maxRows = 5_000_000;

function rowCounts(found, rows, path) {
 if (isInt(rows, 1, maxRows)) return { small: rows, large: rows };
 if (isObject(rows) && keyed(found, rows, path, ['small', 'large'], 'rows')) {
  const small = integer(found, rows.small, [...path, 'small'], 1, maxRows), large = integer(found, rows.large, [...path, 'large'], 1, maxRows);
  return small && large ? { small: rows.small, large: rows.large } : undefined;
 }
 if (!isObject(rows)) found.add(path, `must be a whole number from 1 to ${count(maxRows)}, or { "small": N, "large": N }.`);
}

function histogram(found, spec, path, rows) {
 if (!isObject(spec) || !Object.keys(spec).length) { found.add(path, 'must map children per parent to the number of parents, for example { "3": 10, "1": 40 }.'); return; }
 let total = 0;
 for (const [children, parents] of Object.entries(spec)) {
  if (!/^[1-9][0-9]*$/.test(children) || !isInt(parents, 1)) { found.add(path, `entry "${children}": ${JSON.stringify(parents)} must be children per parent (a whole number of at least 1) mapped to a parent count of at least 1.`); return; }
  total += Number(children) * parents;
 }
 const wanted = rows ? [...new Set([rows.small, rows.large])] : [];
 if (wanted.some(number => number !== total)) found.add(path, `children x parents sums to ${count(total)} but rows is ${wanted.map(count).join(' and ')}; make the histogram sum equal rows, or change rows.`);
 return total;
}

function parentOf(found, parent, path, earlier, rows) {
 const spec = isObject(parent) && 'histogram' in parent ? ['table', 'histogram'] : ['table', 'per'];
 if (!keyed(found, parent, path, spec, 'parent')) return;
 if (typeof parent.table !== 'string' || !identifier.test(parent.table)) found.add([...path, 'table'], 'must name the parent table.');
 else if (!earlier.includes(parent.table)) found.add([...path, 'table'], `${parent.table} must be listed earlier in shape.tables than the table that belongs to it; move ${parent.table} up, or correct the name.`);
 if ('histogram' in parent) histogram(found, parent.histogram, [...path, 'histogram'], rows);
 else integer(found, parent.per, [...path, 'per'], 1, undefined, 'per is the number of children each parent row gets');
}

function sql(found, value, path) {
 const problem = expressionProblem(value);
 if (problem) found.add(path, `${problem}.`);
}

function values(found, spec, path) {
 if (!isObject(spec) || !Object.keys(spec).length) { found.add(path, 'must map each column to a SQLite expression, for example { "id": "printf(\'c%06d\', n)" }.'); return; }
 for (const [column, expression] of Object.entries(spec)) {
  if (!identifier.test(column)) { found.add([...path, column], 'is not a column name (letters, digits and underscore).'); continue; }
  if (isObject(expression)) {
   if (!keyed(found, expression, [...path, column], ['jsonArray'], 'a column value')) continue;
   if (keyed(found, expression.jsonArray, [...path, column, 'jsonArray'], ['length', 'item'], 'jsonArray')) {
    sql(found, expression.jsonArray.length, [...path, column, 'jsonArray', 'length']);
    sql(found, expression.jsonArray.item, [...path, column, 'jsonArray', 'item']);
   }
  } else sql(found, expression, [...path, column]);
 }
}

// shape: { tables, after }. Returns the normalized shape, or undefined when it has problems.
export function validateShape(found, shape, path) {
 if (!keyed(found, shape, path, ['tables', 'after'], 'shape')) return;
 const tables = shape.tables, after = shape.after ?? [], normalized = { tables: [], after: [] }, before = found.list.length;
 if (!Array.isArray(tables) || tables.length < 1 || tables.length > 64) found.add([...path, 'tables'], 'must list 1 to 64 tables, each with its rows and column values.');
 else tables.forEach((table, index) => {
  const here = [...path, 'tables', typeof table?.table === 'string' && identifier.test(table.table) ? table.table : index];
  if (!keyed(found, table, here, ['table', 'rows', 'chunk', 'parent', 'values'], 'a table')) return;
  if (typeof table.table !== 'string' || !identifier.test(table.table)) found.add([...here, 'table'], 'must be the table name (letters, digits and underscore).');
  const rows = table.rows === undefined ? (found.add([...here, 'rows'], 'is required; give the row count or { "small": N, "large": N }.'), undefined) : rowCounts(found, table.rows, [...here, 'rows']);
  if (table.chunk !== undefined) integer(found, table.chunk, [...here, 'chunk'], 100, 50_000);
  if (table.parent !== undefined) parentOf(found, table.parent, [...here, 'parent'], tables.slice(0, index).map(earlier => earlier?.table), rows);
  if (table.values === undefined) found.add([...here, 'values'], 'is required; map each column to a SQLite expression.');
  else values(found, table.values, [...here, 'values']);
  normalized.tables.push({ ...table, rows: rows ?? table.rows, chunk: table.chunk ?? 10_000 });
 });
 if (!Array.isArray(after) || after.length > 16) found.add([...path, 'after'], 'must list at most 16 single statements.');
 else after.forEach((statement, index) => sql(found, statement, [...path, 'after', index]));
 normalized.after = after;
 return found.list.length === before ? normalized : undefined;
}
