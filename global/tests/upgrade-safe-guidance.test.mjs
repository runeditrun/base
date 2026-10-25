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
 for (const fixture of ['dirty', 'detached', 'other-branch']) {
  const child = f.start(['upgrade', '--to', broken.commit, '--anchors', f.anchors, '--json']);
  let reached = false;
  for (let i = 0; i < 60_000 && !reached; i++) {
   reached = (await readJournal(f.root))?.stage === 'started';
   if (!reached) await delay(2);
  }
  assert.ok(reached, 'post-switch crash boundary reached');
  child.kill('SIGKILL'); await child.done;
  const deadline = Date.now() + 30_000;
  while ((await liveServers(f.env)).some(r => r.checkout === f.root) && Date.now() < deadline) await delay(100);
  const journal = await readJournal(f.root);
  const saved = await readFile(join(f.root, '.rer/upgrade/journal.json'));
  if (fixture === 'dirty') {
   await writeFile(join(f.root, owner.path), owner.contents + 'Uncommitted owner edit\n');
   await writeFile(join(f.root, 'owner-untracked.md'), 'Untracked owner edit\n');
  } else if (fixture === 'detached') await f.git(f.root, 'checkout', '-q', '--detach');
  else await f.git(f.root, 'checkout', '-q', '-b', 'owner-other-branch');
  const refused = await f.run(['upgrade', '--to', broken.commit, '--anchors', f.anchors, '--json']);
  assert.equal(result(refused).error_code, fixture === 'dirty' ? 'worktree_dirty' : 'not_on_branch');
  assert.doesNotMatch(refused.stderr, /git\s+reset\s+--hard|rer\s+dev\s+--stop|&&/);
  assert.deepEqual(await readFile(join(f.root, '.rer/upgrade/journal.json')), saved);
  const commands = refused.stderr.split('\n').filter(line => /^(git stash push |git checkout |rer upgrade --cwd |git stash pop$)/.test(line));
  assert.ok(commands.some(line => line.startsWith('rer upgrade --cwd ')));
  for (const command of commands) await f.command('sh', ['-c', command], f.root);
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), journal.head);
  assert.equal((await readJournal(f.root)).stage, 'rolled_back');
  assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
  if (fixture === 'dirty') {
   assert.equal(await readFile(join(f.root, owner.path), 'utf8'), owner.contents + 'Uncommitted owner edit\n');
   assert.equal(await readFile(join(f.root, 'owner-untracked.md'), 'utf8'), 'Untracked owner edit\n');
   await writeFile(join(f.root, owner.path), owner.contents);
   await rm(join(f.root, 'owner-untracked.md'));
  }
  assert.equal((await fetch(f.url + '/health')).status, 200);
  t.diagnostic(JSON.stringify({ fixture, killedPid: child.pid, refusal: result(refused), commands, ownerRowRestored: true, editsKept: true }));
 }
 await stopOwnedApp(f.env, f.root);
});
