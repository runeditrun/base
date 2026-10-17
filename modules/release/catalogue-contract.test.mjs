import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue } from './catalogue.mjs';
import { contractAround, contractText } from './contract-fixture.mjs';

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
  const definitions = [
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
  ];
  const contract = contractAround(definitions, [['DEMO-001', 'Preserve Title'], ['DEMO-002', 'Keep another title'], ['DEMO-003', 'Keep hyphen form']]).split('\n').join('\r\n');

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

test('heading and bold-paragraph clauses list the same as bullets, and only published ones are listed', () => {
  const clauses = [
    { id: 'DEMO-001', title: 'Bullet form', body: 'Bullet body.' },
    { id: 'DEMO-002', title: 'Paragraph form', body: 'Paragraph body.', form: 'paragraph' },
    { id: 'DEMO-003', title: 'Heading form', body: 'Heading body\nover two lines.', form: 'heading' },
    { id: 'DEMO-004', title: 'Later work', body: 'Not published.', kind: 'target', form: 'heading' },
  ];
  assert.deepEqual(manifestFor(contractText(clauses)).listing.clauses, [
    { id: 'DEMO-001', title: 'Bullet form', text: 'Bullet body.' },
    { id: 'DEMO-002', title: 'Paragraph form', text: 'Paragraph body.' },
    { id: 'DEMO-003', title: 'Heading form', text: 'Heading body over two lines.' },
  ]);
});

test('catalogue omits empty clause bodies and rejects contracts with no published clauses', () => {
  const listing = manifestFor(contractAround([
    '- **DEMO-001 — Empty body.**',
    '- **DEMO-002 — Published body.** This clause has content.',
  ], [['DEMO-001', 'Empty body'], ['DEMO-002', 'Published body']])).listing;
  assert.deepEqual(listing.clauses, [
    { id: 'DEMO-002', title: 'Published body', text: 'This clause has content.' },
  ]);

  for (const contract of [
    contractAround(['- **DEMO-001 — Empty body.**', ''], [['DEMO-001', 'Empty body']]),
    contractText([{ id: 'DEMO-001', title: 'Later work', body: 'Not published.', kind: 'target' }]),
  ]) assert.throws(() => manifestFor(contract), /CONTRACT\.md must contain published clauses/);
  assert.throws(() => manifestFor('# Contract\nUnstructured text only.\n'), /CONTRACT\.md:\d+: CONTRACT\.md has no "## Status" section/);
});
