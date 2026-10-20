import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    entries: new Map([...files.keys()].map(path => [path, { type: 'blob', oid: 'fixture-blob' }])),
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


function listingRepo(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'rer-listing-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = resolve(root, 'seed'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const put = (path, bytes) => { mkdirSync(dirname(resolve(repo, path)), { recursive: true }); writeFileSync(resolve(repo, path), bytes); };
  put('seed.json', JSON.stringify({ id: 'listing-id', name: 'Fixture', version: '1.0.0', description: 'Product facts.', category: 'tools', maturity: 'test', headline: 'The product headline.' }));
  put('RELEASE.json', '{}');
  put('rer-project.json', JSON.stringify({ sourceRepository: 'https://github.com/octocat/Hello-World' }));
  put('public/brand/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>');
  put('src/branding.json', JSON.stringify({ primaryColor: '#123456' }));
  put('public/rer-theme.css', ':root { --rer-text: #111111; --rer-page: #ffffff; }');
  put('src/site/home.ts', 'homepage'); put('src/site/docs/help.ts', 'docs');
  put('public/theme/app.js', 'product'); put('src/domain/service.ts', 'backend');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Synthetic listing input'); return git('rev-parse', 'HEAD'); };
  const invoke = (ref, label) => {
    const output = resolve(root, label);
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../bin/rer.mjs'), 'listing', '--repo', repo, '--ref', ref, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { listing: JSON.parse(readFileSync(resolve(output, 'listing.json'))), output };
  };
  return { repo, root, put, git, commit, invoke };
}

test('listing CLI fingerprints committed look files, ignores backend/docs/dirty files and honors declared globs', t => {
  const f = listingRepo(t), first = f.commit();
  const base = f.invoke(first, 'base');
  assert.equal(base.listing.slug, 'hello-world');
  assert.equal(base.listing.homepage, 'https://run-hello-world.com');
  assert.equal(base.listing.headline, 'The product headline.');
  assert.equal(readFileSync(resolve(base.output, base.listing.brand.mark), 'utf8'), readFileSync(resolve(f.repo, 'public/brand/mark.svg'), 'utf8'));
  const homePaths = ['public/brand/mark.svg', 'public/rer-theme.css', 'src/branding.json', 'src/site/home.ts'].sort();
  const lines = homePaths.map(path => `${path}\0${f.git('rev-parse', `${first}:${path}`)}\n`).join('');
  assert.equal(base.listing.look.home, 'sha256:' + createHash('sha256').update(lines).digest('hex'));
  f.put('src/domain/service.ts', 'new backend'); f.put('migrations/001.sql', 'SELECT 1;'); f.put('src/site/docs/help.ts', 'new docs');
  assert.deepEqual(f.invoke(f.commit(), 'backend').listing.look, base.listing.look);
  f.put('public/brand/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
  const mark = f.invoke(f.commit(), 'mark').listing;
  assert.notEqual(mark.look.home, base.listing.look.home);
  f.put('public/app.css', 'body { color: red; }');
  const css = f.invoke(f.commit(), 'css').listing;
  assert.notEqual(css.look.app, mark.look.app);
  f.put('public/rer-theme.css', 'dirty working copy');
  assert.deepEqual(f.invoke(first, 'old-ref').listing, base.listing);
  f.git('checkout', '--', 'public/rer-theme.css');
  f.put('rer-project.json', JSON.stringify({ sourceRepository: 'https://github.com/octocat/Hello-World', look: { home: ['src/site/**', '!src/site/docs/**'], app: ['public/theme/**'] } }));
  const custom = f.invoke(f.commit(), 'custom').listing;
  f.put('public/app.css', 'body { color: blue; }'); f.put('public/brand/mark.svg', '<svg/>');
  assert.deepEqual(f.invoke(f.commit(), 'excluded').listing.look, custom.look);
});

test('listing reuses public-tag shots and preserves their app fingerprint until screenshot bytes change', t => {
  const f = listingRepo(t);
  // A small real lossless WebP with its VP8L image dimensions set to 1600x1000.
  const shot = Buffer.from('UklGRmYAAABXRUJQVlA4TFkAAAAvP8b5AAfQ//73v/8BAEX6/58i+p/63//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3vf/+7BQA=', 'base64');
  const screenshots = [{ path: 'shots/app.webp', alt: 'The product workbench', caption: 'Work in progress.', width: 1600, height: 1000 }];
  f.put('shots/app.webp', shot); f.put('RELEASE.json', JSON.stringify({ screenshots }));
  const first = f.commit();
  // A file remote stands in for the public Git network edge, never local tags.
  const remote = resolve(f.root, 'public.git');
  execFileSync('git', ['clone', '--bare', f.repo, remote], { stdio: 'pipe' });
  f.git('remote', 'add', 'origin', remote); f.git('tag', '-a', 'v1.0.0', '-m', 'Release'); f.git('push', '-q', 'origin', 'v1.0.0');
  const initial = f.invoke(first, 'initial').listing;
  f.put('src/domain/service.ts', 'backend release');
  f.put('seed.json', JSON.stringify({ id: 'listing-id', version: '1.1.0' }));
  const backend = f.invoke(f.commit(), 'backend').listing;
  assert.deepEqual(backend.shots, initial.shots); assert.equal(backend.look.shotsAt, initial.look.app);
  f.put('public/app.css', 'body { color: red; }');
  const changed = f.invoke(f.commit(), 'changed').listing;
  assert.deepEqual(changed.shots, initial.shots); assert.notEqual(changed.look.app, changed.look.shotsAt);
  f.git('tag', '-a', 'v1.1.0', '-m', 'Release'); f.git('push', '-q', 'origin', 'v1.1.0');
  f.put('seed.json', JSON.stringify({ id: 'listing-id', version: '1.2.0-rc.1' }));
  assert.equal(f.invoke(f.commit(), 'carried').listing.look.shotsAt, initial.look.app);
  const fresh = Buffer.from('UklGRmIAAABXRUJQVlA4TFYAAAAvP8b5AAcQEf0PACjS//8U0f/U//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vfLQ==', 'base64'); f.put('shots/app.webp', fresh);
  const captured = f.invoke(f.commit(), 'captured').listing;
  // App look did not move since v1.1.0, so the public shots still win.
  assert.equal(captured.look.shotsAt, initial.look.app);
  assert.deepEqual(readFileSync(resolve(f.root, 'captured', captured.shots[0].path)), shot);
  f.put('public/app.css', 'body { color: green; }');
  const refreshed = f.invoke(f.commit(), 'refreshed').listing;
  assert.equal(refreshed.look.shotsAt, refreshed.look.app);
  f.put('shots/app.webp', Buffer.from('not a webp'));
  const badRef = f.commit();
  const bad = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../bin/rer.mjs'), 'listing', '--repo', f.repo, '--ref', badRef, '--output', resolve(f.root, 'bad')], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /WebP/);
});
