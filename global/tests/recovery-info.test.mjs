import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upgradeFixture } from './fixtures/upgrade/fixture.mjs';
import { snapshot, writeJournal } from '../local-run/state.mjs';
import { recoveryInfo } from '../local-run/index.mjs';
import { run } from './harness.mjs';

const result = r => r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).findLast(e => e.event === 'result');

test('recovery binds local task facts and emits checkout-scoped commands only for safe names', { timeout: 5 * 60_000 }, async t => {
 const f = await upgradeFixture(t, { checkoutName: 'owner-app' });
 await f.git(f.directory, 'clone', '--quiet', f.source, f.root);
 await f.git(f.root, 'remote', 'set-url', 'origin', f.repositoryURL);
 const owner = await f.ownerCommit();
 const head = await f.git(f.root, 'rev-parse', 'HEAD');
 assert.equal(head, owner.commit); assert.notEqual(head, f.v1.commit); assert.notEqual(head, f.v2.commit);
 await mkdir(join(f.root, '.rer/local'), { recursive: true });
 await writeFile(join(f.root, '.rer/local/owner.json'), 'owner snapshot bytes\n');
 const from = { repository: f.repository, commit: f.v1.commit }, target = { repository: f.repository, commit: f.v2.commit };
 const backup = await snapshot(f.root, { head, from, target, wasRunning: false, release: null });
 const journal = { version: 1, journalKey: 'task-recovery', checkout_name: 'owner-app', head, branch: 'main', from, target, backup, stage: 'rollback_failed', wasRunning: false };
 const options = { checkout: f.root, journalKey: journal.journalKey, repository: f.repository, fromCommit: from.commit, toCommit: target.commit };
 const unavailable = reason => ({ status: 'unavailable', reason });
 const readerCases = [];
 async function readRecovery(input) {
  const recovery = await recoveryInfo(input); readerCases.push({ ...input, checkout: undefined, recovery }); return recovery;
 }
 assert.deepEqual(await readRecovery(options), unavailable('journal_missing'));
 await writeFile(join(f.root, '.rer/upgrade/journal.json'), '{invalid');
 assert.deepEqual(await readRecovery(options), unavailable('journal_invalid'));
 await writeJournal(f.root, journal);
 const expected = { status: 'available', previous_head: head, checkout_name: 'owner-app', backup_name: backup };
 assert.deepEqual(await readRecovery(options), expected);
 for (const altered of [{ journalKey: 'another-task' }, { repository: 'other/repository' }, { fromCommit: head }, { toCommit: head }]) {
  assert.deepEqual(await readRecovery({ ...options, ...altered }), unavailable('journal_invalid'));
 }
 for (const field of ['journalKey', 'checkout_name', 'head', 'from', 'target']) {
  const older = { ...journal }; delete older[field]; await writeJournal(f.root, older);
  assert.deepEqual(await readRecovery(options), unavailable('journal_invalid'));
 }
 await writeJournal(f.root, journal);
 const metadataPath = join(f.root, '.rer/upgrade/backups', backup, 'backup.json'), metadata = await readFile(metadataPath);
 await rm(metadataPath); assert.deepEqual(await readRecovery(options), unavailable('backup_missing'));
 await writeFile(metadataPath, metadata);
 const saved = join(f.root, '.rer/upgrade/backups', backup, 'state/.rer/local/owner.json');
 await rm(saved); assert.deepEqual(await readRecovery(options), unavailable('backup_missing'));
 await writeFile(saved, 'owner snapshot bytes\n');
 const mismatched = JSON.parse(metadata); mismatched.head = f.v1.commit;
 await writeFile(metadataPath, JSON.stringify(mismatched)); assert.deepEqual(await readRecovery(options), unavailable('journal_invalid'));
 await writeFile(metadataPath, metadata);
 const missingBackup = { ...journal }; delete missingBackup.backup; await writeJournal(f.root, missingBackup);
 assert.deepEqual(await readRecovery(options), unavailable('backup_missing'));
 await writeJournal(f.root, journal);
 const bin = join(f.directory, 'recovery-bin'); await mkdir(bin);
 const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
 await writeFile(join(bin, 'rer'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(f.rer)} "$@"\n`);
 await chmod(join(bin, 'rer'), 0o755); f.env.PATH = `${bin}:${f.env.PATH}`;
 const emitted = await f.run(['upgrade', '--json']);
 assert.equal(result(emitted).error_code, 'rollback_failed');
 const command = emitted.stderr.split('\n').find(line => line.startsWith('rer upgrade --cwd '));
 assert.ok(command);
 assert.doesNotMatch(emitted.stderr, /git\s+reset|rer\s+dev\s+--stop/);
 const wrong = join(f.directory, 'wrong-directory'); await mkdir(wrong);
 await f.git(wrong, 'init', '--quiet');
 await f.git(wrong, 'fetch', '--quiet', f.root, head);
 await f.git(wrong, 'checkout', '--quiet', '-b', 'caller', 'FETCH_HEAD');
 await writeFile(join(wrong, 'keep'), 'keep caller checkout');
 await f.git(wrong, 'add', '.'); await f.git(wrong, 'commit', '--quiet', '-m', 'Caller state');
 const callerHead = await f.git(wrong, 'rev-parse', 'HEAD');
 const away = join(f.directory, 'temporarily-away');
 await rename(f.root, away);
 let failedCwd;
 try { failedCwd = await run('/bin/sh', ['-c', command], { cwd: wrong, env: f.env }); }
 finally { await rename(away, f.root); }
 assert.notEqual(failedCwd.code, 0); assert.equal(await f.git(wrong, 'rev-parse', 'HEAD'), callerHead);
 assert.equal(await readFile(join(wrong, 'keep'), 'utf8'), 'keep caller checkout');
 for (const name of ['owner app', "owner'app", '$(printf gate-expanded)', '`printf gate-expanded`', 'owner\napp', '-owner', '日本語', 'a/b', '..', 'owner%2fapp']) {
  if (name.includes('/') || name === '..') continue; // Filesystem names only; API path-shaped identity is checked above.
  const moved = join(f.directory, name); await rename(f.root, moved);
  assert.deepEqual(await readRecovery({ ...options, checkout: moved }), unavailable('checkout_name_unsafe'));
  const refused = await f.run(['upgrade', '--json'], { cwd: moved });
  assert.equal(result(refused).error_code, 'rollback_failed');
  assert.ok(!refused.stderr.includes('cd -- ') && !refused.stderr.includes('git reset'));
  t.diagnostic(JSON.stringify({ basename: name, result: result(refused), containsNewline: name.includes('\n'), recovery: await readRecovery({ ...options, checkout: moved }), executableCommands: false }));
  await rename(moved, f.root);
 }
 const moved = join(f.directory, 'renamed-app'); await rename(f.root, moved);
 assert.deepEqual(await readRecovery({ ...options, checkout: moved }), unavailable('journal_invalid'));
 await rename(moved, f.root);
 t.diagnostic(JSON.stringify({ readerCases, recovery: expected, command, failedCwdExit: failedCwd.code, callerCheckoutKept: true }));
});
