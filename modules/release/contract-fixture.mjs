// A CONTRACT.md that parseContract accepts, for release fixtures. contractAround
// wraps hand-written definition lines (under a "## What it does" heading, which
// they may continue with headings of their own) with the Product target table
// and a Status table of one done row per [id, title, kind] given; contractText
// writes both from clauses { id, title, body, kind = 'published', form = 'bullet'
// | 'paragraph' | 'heading' }.
export const contractAround = (definitions, rows) => [
  '# Fixture contract', '', '## Product target', '',
  '| Row | Value |', '|---|---|', '| Category | Fixture tools |', '| Incumbents a buyer switches from | Spreadsheets |', '| First buyer | A fixture owner |', '',
  '## What it does', '', ...definitions, '',
  '## Status', '', 'Judged from the code and tests at commit `0123456` (2026-10-17).', '',
  '| Clause | Title | Kind | Status | Evidence | Gap |', '|---|---|---|---|---|---|',
  ...rows.map(([id, title, kind = 'published']) => `| \`${id}\` | ${title} | ${kind} | done | \`CONTRACT.md\` | |`), '',
].join('\n');

export const contractText = (clauses = [{ id: 'TEST-001', title: 'Exact bytes', body: 'Export the verified committed bytes.' }]) => {
  const define = ({ id, title, body, form = 'bullet' }) => form === 'heading' ? [`### ${id} — ${title}.`, '', body, ''] : [`${form === 'bullet' ? '- ' : ''}**${id} — ${title}.** ${body}`, ''];
  const published = clauses.filter(clause => (clause.kind ?? 'published') === 'published'), later = clauses.filter(clause => clause.kind && clause.kind !== 'published');
  return contractAround([...published.flatMap(define), ...(later.length ? ['## Target clauses', '', '### Later', '', ...later.flatMap(define)] : [])],
    clauses.map(({ id, title, kind }) => [id, title, kind]));
};
