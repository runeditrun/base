import { readFile } from 'node:fs/promises';
import { sqlTokens } from '../../modules/deploy-kit/sql-tokens.mjs';
import { invalid, missing } from '../errors.mjs';
import { fromItems, tokenize, viewScope } from './from-items.mjs';
import { depthMeter, MeasureError } from './expression-depth.mjs';
import { schemaObjects } from './schema-objects.mjs';
import { failAt } from './limits.mjs';

/** The fleet runner's statements file: { statements: [{ name, sql, params? }] }.
 * Other keys, and params, are ignored. */
export async function readStatementsFile(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { throw missing(`Cannot read the statements file ${path}: ${error.code ?? error.message}.`); }
  let file;
  try { file = JSON.parse(text); } catch { throw invalid(`${path} is not JSON. Expected {"statements":[{"name":"...","sql":"..."}]}.`); }
  if (!Array.isArray(file?.statements) || !file.statements.every(item => typeof item?.name === 'string' && typeof item?.sql === 'string'))
    throw invalid(`${path} must hold {"statements":[{"name":"...","sql":"..."}]}, each with a name and sql.`);
  return file.statements.map(({ name, sql }) => ({ name, sql }));
}

// A trailing ; is fine; a second statement would go unmeasured.
function oneStatement(sql) {
  const t = sqlTokens(sql);
  const stop = t.findIndex((token, i) => token.kind === 'symbol' && token.value === ';' && i < t.length - 1);
  if (stop >= 0) throw new MeasureError('it holds more than one statement; give each statement its own entry');
}

/** Measure statements against a database holding the schema. Each record is
 * { name, fromItems, depth, ok } or, when SQLite cannot compile the statement
 * (or it cannot be measured), { name, ok: false, error }. A statement's depth
 * is looked up exactly when it fails (by either measure), when `exact` asks for every one, and
 * when it is the largest passing so far; otherwise it is only known to pass. */
export function measureStatements(db, statements, { exact = false } = {}) {
  const scope = viewScope(schemaObjects(db).views), meter = depthMeter(db);
  let largest = 1;
  return statements.map(({ name, sql }) => {
    try {
      oneStatement(sql);
      try { db.prepare(sql); } catch (error) { throw new MeasureError(`SQLite cannot compile it: ${error.message}`); }
      const tokens = tokenize(sql), parts = meter.parts(sql);
      const items = fromItems(sql, scope, tokens);
      let depth;
      if (!meter.atMost(parts, failAt.depth - 1)) depth = meter.exact(parts);
      else {
        if (exact || items >= failAt.fromItems || !meter.atMost(parts, largest)) depth = meter.exact(parts);
        if (items < failAt.fromItems) largest = Math.max(largest, depth ?? 1);
      }
      return { name, fromItems: items, depth: depth ?? null, ok: items < failAt.fromItems && (depth ?? 0) < failAt.depth };
    } catch (error) {
      return { name, ok: false, error: error.message };
    }
  });
}
