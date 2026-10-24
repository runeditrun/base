import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upgradeFixture, ownerRow } from './fixtures/upgrade/fixture.mjs';
import { readJournal } from '../local-run/state.mjs';

const result = r => r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).findLast(e => e.event === 'result');
const canonical = (repository, release) => `{\n  "schema": 1,\n  "repository": ${JSON.stringify(repository)},\n  "tag": ${JSON.stringify(release.tag)},\n  "commit": ${JSON.stringify(release.commit)}\n}\n`;

test('committed release records refuse ambiguity and survive successive upgrades and rollback', { timeout: 20 * 60_000 }, async t => {
 const f = await upgradeFixture(t);
 await f.launch(); await f.ownerCommit(); await f.addRow();
 const original = await f.git(f.root, 'rev-parse', 'HEAD');
 const bytes = canonical(f.repository, f.v1);
 assert.equal(await f.git(f.root, 'show', 'HEAD:rer-upstream.json'), bytes.trimEnd());
 const record = JSON.parse(bytes);
 const malformed = [
  ['json', '{'], ['null', 'null'], ['array', '[]'],
  ['schema', JSON.stringify({ ...record, schema: 2 })],
  ['extra', JSON.stringify({ ...record, version: f.v1.tag.slice(1) })],
  ...Object.keys(record).map(key => ['missing-' + key, JSON.stringify(Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)))]),
  ['duplicate', bytes.replace('"schema": 1,', '"schema": 1, "schema": 1,')],
  ['escaped-duplicate', bytes.replace('"schema": 1,', '"schema": 1, "\\u0073chema": 1,')],
  ['repository', JSON.stringify({ ...record, repository: '../owner' })],
  ['other-repository', JSON.stringify({ ...record, repository: 'runeditrun/base' })],
  ['tag', JSON.stringify({ ...record, tag: 'main' })],
  ['commit', JSON.stringify({ ...record, commit: f.v1.commit.slice(0, 12) })],
  ['commit-type', JSON.stringify({ ...record, commit: {} })],
 ];
 for (const [name, source] of malformed) {
  await f.git(f.root, 'reset', '--hard', original);
  await f.ownerCommit('rer-upstream.json', source);
  const head = await f.git(f.root, 'rev-parse', 'HEAD');
  const refused = await f.run(['upgrade', '--to', f.v2.commit, '--anchors', f.anchors, '--check', '--json']);
  assert.equal(result(refused).outcome, 'refused', name);
  assert.match(refused.stderr, /rer-upstream\.json/, name);
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), head, name);
 }
 await f.git(f.root, 'reset', '--hard', original);
 const first = await f.run(['upgrade', '--to', f.v2.commit, '--anchors', f.anchors, '--json']);
 assert.equal(first.code, 0, first.stderr);
 const secondBytes = canonical(f.repository, f.v2);
 assert.equal(await readFile(join(f.root, 'rer-upstream.json'), 'utf8'), secondBytes);
 assert.equal(await f.git(f.root, 'show', 'HEAD:rer-upstream.json'), secondBytes.trimEnd());
 const next = await f.publish('3.0.0');
 // Obsolete metadata is deliberately stale. Neither it nor a later trailer
 // can override the committed record written by the first upgrade.
 await writeFile(join(f.root, '.rer/release.json'), JSON.stringify({ repository: f.repository, ...f.v1 }));
 await f.git(f.root, 'commit', '--allow-empty', '-qm', 'Legacy release metadata', '-m', `RER-Upstream-Release: ${f.repository}@${f.v1.commit}`);
 const second = await f.run(['upgrade', '--to', next.commit, '--anchors', f.anchors, '--json']);
 assert.equal(second.code, 0, second.stderr);
 const journal = await readJournal(f.root);
 assert.equal(journal.from.commit, f.v2.commit);
 assert.equal(journal.from.tag, f.v2.tag);
 assert.equal(await readFile(join(f.root, 'rer-upstream.json'), 'utf8'), canonical(f.repository, next));
 assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
 const restored = await f.run(['upgrade', '--restore', journal.backup, '--json']);
 assert.equal(restored.code, 0, restored.stderr);
 assert.equal(await readFile(join(f.root, 'rer-upstream.json'), 'utf8'), secondBytes);
 assert.equal(await f.git(f.root, 'show', 'HEAD:rer-upstream.json'), secondBytes.trimEnd());
 await f.git(f.root, 'rm', 'rer-upstream.json');
 await f.git(f.root, 'commit', '-qm', 'Legacy checkout without an installed record');
 const legacyHead = await f.git(f.root, 'rev-parse', 'HEAD');
 const legacy = await f.run(['upgrade', '--to', next.commit, '--anchors', f.anchors, '--check', '--json']);
 assert.equal(result(legacy).error_code, 'release_not_found');
 assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), legacyHead);
 assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
 t.diagnostic(JSON.stringify({ malformed: malformed.map(([name]) => name), canonicalUpgrades: 2, rollbackRestoredRecord: true, legacy: result(legacy).error_code }));
});
