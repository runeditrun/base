import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { upgradeFixture, ownerRow } from './fixtures/upgrade/fixture.mjs';
import { stopOwnedApp } from './fixtures/upgrade/owned-app.mjs';
import { readJournal } from '../local-run/state.mjs';
import { liveServers } from '../registry.mjs';

const result = r => r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).findLast(e => e.event === 'result');
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
test('printed recovery restores owner data and preserves dirty, detached and other-branch owner work', { timeout: 20 * 60_000 }, async t => {
 const f = await upgradeFixture(t, { checkoutName: 'recovery-checkout' });
 await f.launch(); const owner = await f.ownerCommit(); await f.addRow();
 const broken = await f.publish('3.0.0', source => writeFile(join(source, 'migrations/core/0035_delete_records.sql'), 'DELETE FROM upgrade_records;\n'));
 const bin = join(f.directory, 'recovery-bin'); await mkdir(bin);
 await writeFile(join(bin, 'rer'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(f.rer)} "$@"\n`);
 await chmod(join(bin, 'rer'), 0o755); f.env.PATH = `${bin}:${f.env.PATH}`;
 for (const fixture of ['dirty', 'detached', 'other-branch', 'unborn']) {
  const child = f.start(['upgrade', '--to', broken.commit, '--anchors', f.anchors, '--json']);
  let reached = false;
  for (let i = 0; i < 60_000 && !reached; i++) {
   // Atomic journal replacement may retire the descriptor while observed.
   reached = await readFile(join(f.root, '.rer/upgrade/journal.json'), 'utf8').then(bytes => JSON.parse(bytes).stage === 'started', () => false);
   if (!reached) await delay(2);
  }
  assert.ok(reached, 'post-switch crash boundary reached');
  child.kill('SIGKILL'); await child.done;
  const deadline = Date.now() + 30_000;
  while ((await liveServers(f.env)).some(r => r.checkout === f.root) && Date.now() < deadline) await delay(100);
  const journal = await readJournal(f.root);
  const saved = await readFile(join(f.root, '.rer/upgrade/journal.json'));
  await writeFile(join(f.root, owner.path), owner.contents + 'Uncommitted owner edit\n');
  await writeFile(join(f.root, 'owner-untracked.md'), 'Untracked owner edit\n');
  if (fixture === 'detached') await f.git(f.root, 'checkout', '-q', '--detach');
  else if (fixture === 'other-branch') await f.git(f.root, 'checkout', '-q', '-b', 'owner-other-branch');
  else if (fixture === 'unborn') await f.git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/owner-unborn');
  const refused = await f.run(['upgrade', '--to', broken.commit, '--anchors', f.anchors, '--json']);
  assert.equal(result(refused).error_code, ['detached', 'unborn'].includes(fixture) ? 'not_on_branch' : 'worktree_dirty');
  assert.doesNotMatch(refused.stderr, /git\s+reset\s+--hard|rer\s+dev\s+--stop|&&/);
  assert.deepEqual(await readFile(join(f.root, '.rer/upgrade/journal.json')), saved);
  const lines = refused.stderr.split('\n');
  const commands = lines.filter((line, i) => i > 0 && lines[i - 1].endsWith(':') && /^(git |rer )/.test(line));
  assert.ok(commands.some(line => line.startsWith('rer upgrade --restore ')));
  for (const command of commands) await f.command('sh', ['-c', command], f.root);
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), journal.head);
  assert.equal((await readJournal(f.root)).stage, 'rolled_back');
  assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
  if (fixture === 'unborn') {
   const saved = await f.git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/rer/recovery-unborn-*');
   assert.ok(saved);
   assert.equal(await f.git(f.root, 'show', `${saved}:${owner.path}`), (owner.contents + 'Uncommitted owner edit\n').trim());
   assert.equal(await f.git(f.root, 'show', `${saved}:owner-untracked.md`), 'Untracked owner edit');
  } else {
   assert.equal(await readFile(join(f.root, owner.path), 'utf8'), owner.contents + 'Uncommitted owner edit\n');
   assert.equal(await readFile(join(f.root, 'owner-untracked.md'), 'utf8'), 'Untracked owner edit\n');
  }
  await writeFile(join(f.root, owner.path), owner.contents);
  await rm(join(f.root, 'owner-untracked.md'), { force: true });
  assert.equal((await fetch(f.url + '/health')).status, 200);
  t.diagnostic(JSON.stringify({ fixture, killedPid: child.pid, refusal: result(refused), commands, ownerRowRestored: true, editsKept: true }));
 }
 await stopOwnedApp(f.env, f.root);
});

test('restore keeps an owner commit and both edited files on a printed recovery branch', { timeout: 10 * 60_000 }, async t => {
 const f = await upgradeFixture(t, { checkoutName: 'committed-recovery' });
 await f.launch(); const owner = await f.ownerCommit(); await f.addRow();
 const child = f.start(['upgrade', '--to', f.v2.commit, '--anchors', f.anchors, '--json']);
 const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
 let killed = false;
 child.stdout.on('data', () => {
  if (!killed && child.stdoutText.split('\n').some(line => {
   try { const e = JSON.parse(line); return e.event === 'phase' && e.phase === 'start'; } catch { return false; }
  })) { killed = true; child.kill('SIGKILL'); }
 });
 assert.equal((await exited).signal, 'SIGKILL');
 const journal = await readJournal(f.root);
 await writeFile(join(f.root, owner.path), owner.contents + 'Committed owner edit\n');
 await writeFile(join(f.root, 'owner-new.md'), 'New owner file\n');
 const dirty = await f.run(['upgrade', '--json']);
 assert.equal(result(dirty).error_code, 'worktree_dirty');
 await f.git(f.root, 'add', '-A'); await f.git(f.root, 'commit', '-qm', 'Preserve owner work');
 const commit = await f.git(f.root, 'rev-parse', 'HEAD');
 const refused = await f.run(['upgrade', '--json']);
 assert.equal(result(refused).error_code, 'refused');
 const command = refused.stderr.split('\n').find(line => line.startsWith('rer upgrade --restore '));
 assert.ok(command);
 const restored = await f.run(['upgrade', '--restore', journal.backup, '--cwd', f.root, '--json']);
 assert.equal(result(restored).outcome, 'rolled_back', restored.stderr);
 assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), journal.head);
 const refs = (await f.git(f.root, 'for-each-ref', '--contains', commit, '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean);
 assert.ok(refs.length);
 const ref = refs.find(name => restored.stderr.includes(name));
 assert.ok(ref, 'restore must print the ref retaining the owner commit');
 assert.equal(await f.git(f.root, 'show', `${ref}:${owner.path}`), (owner.contents + 'Committed owner edit\n').trim());
 assert.equal(await f.git(f.root, 'show', `${ref}:owner-new.md`), 'New owner file');
 assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
 t.diagnostic(JSON.stringify({ killedPid: child.pid, ownerCommit: commit, recoveryBranch: ref, editsKept: true }));
});
