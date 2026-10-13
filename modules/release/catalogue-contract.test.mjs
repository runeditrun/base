import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue } from './catalogue.mjs';

function manifestFor(contract) {
  const files = new Map([
    ['seed.json', '{}'],
    ['CONTRACT.md', contract],
    ['AGENTS.md', 'Fixture instructions.'],
    ['LICENSE', 'Permission is hereby granted, free of charge to use this fixture.'],
    ['RELEASE.json', '{}'],
  ]);
  const source = {
    seed: { id: 'fixture', name: 'Fixture', category: 'tools', maturity: 'production', version: '1.2.3', description: 'Fixture listing.' },
    bytes: path => Buffer.from(files.get(path)),
    entries: new Set(files.keys()),
    commit: 'fixture-commit', tree: 'fixture-tree', tag: null, timestamp: '2026-10-08T00:00:00.000Z',
    publicTagStaged: false,
  };
  return catalogue(source, 'tests/fixture', 'https://example.invalid/fixture', {
    verify: { status: 'PASS' }, publishCheck: { status: 'PASS' },
  }, true);
}

test('catalogue keeps wrapped clause bodies, boundary rules, separators, and canonical titles', () => {
  const contract = [
    '# Contract',
    '',
    '- **DEMO-001 — Preserve Title.** Do not rewrite `x`; retain “café” — exactly!',
    '  The next paragraph includes Unicode 東京 and punctuation: [a/b]; keep it.',
    '',
    '  A third indented paragraph has `inline code` and no changes.',
    'Unindented prose ends this clause and is not part of its body.',
    '## Notes',
    '- **DEMO-002 – Keep another title.** Keep this second clause.',
    '  Its continuation stays with the clause.',
    '## More',
    '- **DEMO-003 - Keep hyphen form.** Final body at EOF with a period.',
  ].join('\r\n');

  const listing = manifestFor(contract).listing;
  assert.equal(listing.clauseCount, 3);
  assert.deepEqual(listing.clauses, [
    {
      id: 'DEMO-001', title: 'Preserve Title',
      text: 'Do not rewrite `x`; retain “café” — exactly! The next paragraph includes Unicode 東京 and punctuation: [a/b]; keep it. A third indented paragraph has `inline code` and no changes.',
    },
    { id: 'DEMO-002', title: 'Keep another title', text: 'Keep this second clause. Its continuation stays with the clause.' },
    { id: 'DEMO-003', title: 'Keep hyphen form', text: 'Final body at EOF with a period.' },
  ]);
});

test('catalogue omits empty clause bodies and rejects contracts with no published clauses', () => {
  const listing = manifestFor([
    '# Contract',
    '- **DEMO-001 — Empty body.**',
    '- **DEMO-002 — Published body.** This clause has content.',
  ].join('\n')).listing;
  assert.deepEqual(listing.clauses, [
    { id: 'DEMO-002', title: 'Published body', text: 'This clause has content.' },
  ]);

  for (const contract of [
    '# Contract\n- **DEMO-001 — Empty body.**\n  \n## End\n',
    '# Contract\nUnstructured text only.\n',
  ]) assert.throws(() => manifestFor(contract), /CONTRACT\.md must contain published clauses/);
});
