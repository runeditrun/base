import { d1Limits, failAt, SIZE_MARGIN } from './limits.mjs';
import { measureStatements } from './statements.mjs';

// What the metered flows add up to. A flow fails when, at either size or between them:
//   ceiling         it read more rows at large than its ceiling;
//   growth          it read more at large than at small by over growthPercent of small plus growthRows
//                   (unless growth.allowed, whose why is printed on every run);
//   status          it answered another status than declared (any 2xx or 3xx, and 101 for a websocket);
//   refused         local D1 refused or failed a statement it ran;
//   statement-size  a distinct statement it ran is at 90 or more FROM items or depth.

const count = number => number.toLocaleString('en-US');
const preview = sql => sql.replace(/\s+/g, ' ').trim().slice(0, 160);
const sizes = ['small', 'large'];

/** The statements of `executions` that read the most rows, summed by text: [{ binding, sql, executions, rowsRead, rowsWritten }]. */
export function topStatements(executions, limit = 3) {
 const groups = new Map();
 for (const { binding, sql, rows_read, rows_written } of executions) {
  const key = `${binding}\0${sql}`, group = groups.get(key) ?? { binding, sql, executions: 0, rowsRead: 0, rowsWritten: 0 };
  group.executions++;
  group.rowsRead += rows_read;
  group.rowsWritten += rows_written;
  groups.set(key, group);
 }
 return [...groups.values()].sort((a, b) => b.rowsRead - a.rowsRead).slice(0, limit);
}

// Every distinct statement text the flows ran (exec text can hold several statements and has no row meta, so it is
// not measured), measured against the schema of its own D1 binding: Map(binding -> Map(sql -> record)).
function measureDistinct(schemas, flowResults) {
 const texts = new Map();
 for (const result of flowResults) for (const { binding, sql, exec } of result.executions) if (!exec) texts.set(binding, (texts.get(binding) ?? new Set()).add(sql));
 const measured = new Map();
 for (const [binding, sqls] of texts) {
  const schema = schemas.find(item => item.binding === binding);
  if (!schema) continue;
  const list = [...sqls], records = measureStatements(schema.db, list.map((sql, index) => ({ name: `statement ${index}`, sql })));
  measured.set(binding, new Map(list.map((sql, index) => [sql, records[index]])));
 }
 return measured;
}

export const flowSummary = run => ({ rowsRead: run.executions.reduce((total, item) => total + item.rows_read, 0), rowsWritten: run.executions.reduce((total, item) => total + item.rows_written, 0), statements: run.executions.length, status: run.status, ms: Math.round(run.ms), ...(run.error ? { error: run.error } : {}), ...(run.detail ? { detail: run.detail } : {}), ...(run.unsettled ? { unsettled: true } : {}), top: topStatements(run.executions) });

// Only the measures at the failing line: a statement at depth 105 says so and not "0 FROM items".
function sizeText({ fromItems, depth }) {
 const parts = [];
 if (fromItems >= failAt.fromItems) parts.push(`${fromItems} FROM items after expanding CTEs and views`);
 if ((depth ?? Infinity) >= failAt.depth) parts.push(`expression depth ${depth ?? 'over the limit'}`);
 return `${parts.join(', ')} (rer fails at ${failAt.fromItems} FROM items or depth ${failAt.depth}; D1 refuses at ${d1Limits.fromItems} and ${d1Limits.depth})`;
}

function statusProblem(flow, run) {
 const expected = flow.status ?? (flow.scheduled === undefined ? flow.request.websocket ? [101] : null : ['ok']);
 const wanted = expected === null ? 'a 2xx or 3xx status' : `status ${expected.join(' or ')}`;
 if (run.error) return `${flow.scheduled === undefined ? 'its request' : 'the scheduled handler'} failed: ${run.error}`;
 const ok = expected === null ? run.status >= 200 && run.status < 400 : expected.includes(run.status);
 if (ok) return null;
 return flow.scheduled === undefined ? `answered HTTP ${run.status}${run.detail ? ` (${run.detail})` : ''}; expected ${wanted}` : `the scheduled handler did not finish (${run.status}); expected it to run to the end`;
}

/**
 * Judges every declared flow. `small` and `large` are the runFlows results of each size, in declared order;
 * `schemas` are the build's D1 schemas ({ binding, db }, see schemasFromBuild) the statements are measured against.
 * Resolves { ok, flows: [{ name, persona, kind, label, ok, failures: [{ rule, message }], growthAllowed, small, large }], checked }.
 */
export function judgeFlows(declaration, small, large, schemas) {
 const { growthPercent, growthRows } = declaration.budget;
 const measured = measureDistinct(schemas, [...small, ...large]);
 const verdicts = declaration.flows.map((flow, index) => {
  const at = { small: small[index], large: large[index] }, failures = [];
  const wrong = new Map();
  for (const size of sizes) { const problem = statusProblem(flow, at[size]); if (problem) wrong.set(problem, [...wrong.get(problem) ?? [], size]); }
  for (const [problem, where] of wrong) failures.push({ rule: 'status', message: `${problem} at ${where.join(' and ')}` });
  const refused = new Map();
  for (const size of sizes) for (const { sql, error } of at[size].executions) if (error) {
   const key = `${sql}\0${error}`;
   refused.set(key, { sql, error, sizes: [...refused.get(key)?.sizes ?? [], size] });
  }
  for (const { sql, error, sizes: where } of refused.values()) failures.push({ rule: 'refused', message: `local D1 refused or failed a statement at ${where.join(' and ')}: ${error.replace(/^D1_ERROR:\s*/, '').replace(/:\s*SQLITE_\w+(?: \(extended: \w+\))?\s*$/, '')}`, sql });
  const rows = { small: at.small.rowsRead, large: at.large.rowsRead };
  if (rows.large > flow.ceiling) failures.push({ rule: 'ceiling', message: `over its ceiling of ${count(flow.ceiling)} at large by ${count(rows.large - flow.ceiling)}${flow.callsInRow > 1 ? ` (${flow.callsInRow} calls in a row)` : ''}` });
  const allowed = Math.floor(growthPercent / 100 * rows.small + growthRows);
  if (rows.large - rows.small > growthPercent / 100 * rows.small + growthRows && !flow.growth) failures.push({ rule: 'growth', message: `grew ${count(rows.large - rows.small)} rows from small to large; allowed ${growthPercent}% of small + ${count(growthRows)} = ${count(allowed)}` });
  const seen = new Set();
  for (const size of sizes) for (const { binding, sql, exec } of at[size].executions) {
   if (exec || seen.has(`${binding}\0${sql}`)) continue;
   seen.add(`${binding}\0${sql}`);
   const record = measured.get(binding)?.get(sql);
   if (!record || record.ok) continue;
   failures.push({ rule: 'statement-size', message: `statement size: ${record.error ?? sizeText(record)}`, sql, ...(record.error ? {} : { fromItems: record.fromItems, depth: record.depth }) });
  }
  return { name: flow.name, persona: flow.persona ?? null, kind: at.small.kind, label: at.small.label, callsInRow: flow.callsInRow, ceiling: flow.ceiling, ok: failures.length === 0, failures, growthAllowed: flow.growth?.why ?? null, small: flowSummary(at.small), large: flowSummary(at.large) };
 });
 const checked = [...measured.values()].reduce((all, records) => all + records.size, 0);
 return { ok: verdicts.every(verdict => verdict.ok), flows: verdicts, checked };
}

/** The lines a person reads: one per flow, each failure's reasons and its three heaviest statements at large, then
 * a summary. */
export function verdictLines(verdict, declaration) {
 const lines = [], widths = { name: 0, persona: 0, label: 0 };
 for (const flow of verdict.flows) for (const key of Object.keys(widths)) widths[key] = Math.max(widths[key], String(flow[key] ?? '').length);
 for (const flow of verdict.flows) {
  const status = flow.large.status ?? 'no response', extra = flow.large.unsettled ? '; work still running after 30 s is not counted' : '';
  lines.push(`  ${flow.ok ? 'ok  ' : 'FAIL'}  ${flow.name.padEnd(widths.name)}  ${String(flow.persona ?? '').padEnd(widths.persona)}  ${flow.label.padEnd(widths.label)}  ${count(flow.small.rowsRead)} → ${count(flow.large.rowsRead)} rows, ${count(flow.large.statements)} statement${flow.large.statements === 1 ? '' : 's'}, ${status}${extra}`);
  if (flow.growthAllowed) lines.push(`        growth allowed: ${flow.growthAllowed}`);
  if (flow.ok) continue;
  for (const failure of flow.failures) {
   lines.push(`        ${failure.message}`);
   if (failure.sql) lines.push(`          ${preview(failure.sql)}`);
  }
  for (const top of flow.large.top.filter(top => top.rowsRead > 0)) lines.push(`        ${count(top.rowsRead)} rows x${count(top.executions)}  ${preview(top.sql)}`);
 }
 const failing = verdict.flows.filter(flow => !flow.ok).length;
 lines.push(`  ${failing ? `${failing} of ${verdict.flows.length} flows fail` : `All ${verdict.flows.length} flows pass`}; ${count(verdict.checked)} distinct statements checked for size. Rows are local D1's own count.`);
 if (failing) lines.push(`  Real D1 also refuses at ${d1Limits.fromItems} FROM items (rer fails at ${failAt.fromItems}, a margin of ${SIZE_MARGIN}) and budgets a database's reads in a 10-second window (here ceiling x calls in a row must stay under ${count(declaration.budget.windowRows)}). Confirm a fix on real D1 before relying on it.`);
 return lines;
}

/** One size's statements in the fleet runner's format: { statements: [{ name: "<flow> #<i>", sql, params }] }, every
 * statement each flow's last run executed, in order, with its parameters as bound. */
export function statementsFile(size, results, { complete = true, error, queueConsumersMeasured = null, unmeasuredFlows = [] } = {}) {
 const statements = [];
 for (const result of results) {
  let index = 0;
  for (const { sql, params, exec } of result.executions) if (!exec) statements.push({ name: `${result.name} #${++index}`, sql, params });
 }
 return { about: `rer size: statements observed at the ${size} size, in order, with their parameters as bound.`, statements, complete, queueConsumersMeasured,
  ...(!complete ? { error, unmeasuredFlows, flows: results.map(run => ({ name: run.name, runs: run.runs, incomplete: run.incomplete, ...flowSummary(run) })) } : {}) };
}
