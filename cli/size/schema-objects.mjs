import { sqlTokens } from '../../modules/deploy-kit/sql-tokens.mjs';

// The statements a schema's views and triggers will run, each as plain SQL that
// compiles on its own: a view as its SELECT, a trigger as its WHEN clause (a
// SELECT) and each body statement, with NEW.x and OLD.x as parameters and
// RAISE(...) as NULL, which have the same expression heights.
const sym = (token, char) => token?.kind === 'symbol' && token.value === char;
const word = token => token?.kind === 'word' ? token.value.toUpperCase() : '';

function neutralise(sql) {
  const t = sqlTokens(sql), replacements = [];
  for (let i = 0; i < t.length; i++) {
    if (['NEW', 'OLD'].includes(word(t[i])) && sym(t[i + 1], '.') && ['word', 'identifier'].includes(t[i + 2]?.kind)) {
      replacements.push([t[i].start, t[i + 2].end, '?']);
      i += 2;
    } else if (word(t[i]) === 'RAISE' && sym(t[i + 1], '(')) {
      let depth = 0, j = i + 1;
      for (; j < t.length; j++) { if (sym(t[j], '(')) depth++; else if (sym(t[j], ')') && !--depth) break; }
      replacements.push([t[i].start, t[Math.min(j, t.length - 1)].end, 'NULL']);
      i = j;
    }
  }
  let out = '', at = 0;
  for (const [start, end, text] of replacements) { out += sql.slice(at, start) + text; at = end; }
  return out + sql.slice(at);
}

// A view's own SELECT: what follows the first top-level AS.
function viewSelect(sql) {
  const t = sqlTokens(sql);
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (sym(t[i], '(')) depth++;
    else if (sym(t[i], ')')) depth--;
    else if (!depth && word(t[i]) === 'AS' && ['SELECT', 'WITH', 'VALUES'].includes(word(t[i + 1]))) return sql.slice(t[i + 1].start);
  }
  throw new Error(`cannot find the SELECT of ${sql.slice(0, 80)}`);
}

// The WHEN clause and the statements between BEGIN and END, split at the
// top-level semicolons that are not inside a CASE ... END.
function triggerParts(sql) {
  const t = sqlTokens(sql);
  const begin = t.findIndex(token => word(token) === 'BEGIN');
  let end = t.length - 1;
  while (end > begin && sym(t[end], ';')) end--;
  if (begin < 0 || word(t[end]) !== 'END') throw new Error(`cannot find the body of ${sql.slice(0, 80)}`);
  const when = t.findIndex(token => word(token) === 'WHEN');
  const statements = [];
  let depth = 0, cases = 0, first = begin + 1;
  const close = last => { if (last > first) statements.push(sql.slice(t[first].start, t[last - 1].end)); first = last + 1; };
  for (let i = begin + 1; i < end; i++) {
    if (sym(t[i], '(')) depth++;
    else if (sym(t[i], ')')) depth--;
    else if (word(t[i]) === 'CASE') cases++;
    else if (word(t[i]) === 'END') cases--;
    else if (sym(t[i], ';') && !depth && !cases) close(i);
  }
  close(end);
  return { when: when >= 0 && when < begin ? sql.slice(t[when + 1].start, t[begin - 1].end) : '', statements };
}

/** From a database holding the schema: { views: [{ name, select }], statements:
 * [{ name, sql }] } for every view and trigger. */
export function schemaObjects(db) {
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY type, name").all();
  const views = [], statements = [];
  for (const object of objects) {
    if (object.type === 'view') {
      const select = viewSelect(object.sql);
      views.push({ name: object.name, select });
      statements.push({ name: `view ${object.name}`, sql: select });
      continue;
    }
    const { when, statements: body } = triggerParts(object.sql), label = `trigger ${object.name}`;
    if (when) statements.push({ name: `${label} WHEN (on ${object.tbl_name})`, sql: `SELECT ${neutralise(when)}` });
    body.forEach((sql, i) => statements.push({ name: `${label} #${i + 1} (on ${object.tbl_name})`, sql: neutralise(sql) }));
  }
  return { views, statements };
}
