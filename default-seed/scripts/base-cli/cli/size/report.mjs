import { SIZE_MARGIN, d1Limits, failAt } from './limits.mjs';

const preview = sql => sql.replace(/\s+/g, ' ').trim().slice(0, 160);

/** What a person reads: each failure named with both numbers and its first 160
 * characters, then a summary, then what to do. `records` are measureStatements
 * results; `sqlByName` finds a statement's text. `unit` names what was checked. */
export function sizeReport(records, sqlOf, unit = 'statements') {
  const failed = records.filter(record => !record.ok), passed = records.filter(record => record.ok);
  const largest = `largest${failed.length ? ' otherwise' : ''} ${Math.max(0, ...passed.map(record => record.fromItems))} FROM items, depth ${Math.max(1, ...passed.map(record => record.depth ?? 0))}`;
  if (!failed.length) return [`Statement size: ${records.length} ${unit} checked; ${largest}.`];
  const lines = [`Statement size (D1 refuses at ${d1Limits.fromItems} FROM items or expression depth ${d1Limits.depth}; rer fails at ${failAt.fromItems}):`];
  for (const record of failed) {
    lines.push(record.error
      ? `  FAIL ${record.name}: ${record.error}`
      : `  FAIL ${record.name}: ${record.fromItems} FROM items after expanding CTEs and views, depth ${record.depth}`);
    lines.push(`       ${preview(sqlOf(record))}`);
  }
  lines.push(`  ${failed.length} of ${records.length} ${unit} fail${failed.length === 1 ? 's' : ''}; ${largest}.`,
    '  A CTE or view counts its FROM items again at every reference, and nested EXISTS, IN and scalar subqueries add their whole depth.',
    `  Read each CTE once, or split the statement in two. D1 changed how it enforces these limits without notice on 10 Nov 2026; the margin of ${SIZE_MARGIN} is for that.`);
  return lines;
}
