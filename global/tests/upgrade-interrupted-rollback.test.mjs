import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upgradeFixture, ownerRow } from './fixtures/upgrade/fixture.mjs';
import { interruptRollback } from './fixtures/upgrade/interrupt-rollback.mjs';
import { backup, readJournal } from '../local-run/state.mjs';
import { recoveryInfo } from '../local-run/recovery.mjs';

const result = r => r.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).findLast(e => e.event === 'result');

test('an interrupted rollback refuses retry until explicit recovery restores its snapshot', { timeout: 20 * 60_000 }, async t => {
 const f = await upgradeFixture(t, { checkoutName: 'owner-checkout' });
 await f.launch(); const owner = await f.ownerCommit(); await f.addRow();
 await mkdir(join(f.root, '.rer/local'), { recursive: true });
 const marker = join(f.root, '.rer/local/customer-record.json');
 await writeFile(marker, 'Keep these exact owner bytes\n');
 const record = await readFile(join(f.root, 'rer-upstream.json'));
 const broken = await f.publish('3.0.0', source => writeFile(join(source, 'migrations/core/0035_remove_owner.sql'), 'DELETE FROM upgrade_records;\n'));
 const args = ['upgrade', '--to', broken.commit, '--anchors', f.anchors, '--json'];
 const interrupted = await interruptRollback(f, args, 'after-reset');
 const journal = await readJournal(f.root), saved = await backup(f.root, journal.backup);
 assert.equal(journal.stage, 'rolling_back');
 assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), owner.commit);
 const journalBytes = await readFile(join(f.root, '.rer/upgrade/journal.json'));
 const retry = await f.run(args);
 assert.equal(result(retry).error_code, 'rollback_failed');
 assert.match(retry.stderr, /rer upgrade --restore/);
 assert.deepEqual(await readFile(join(f.root, '.rer/upgrade/journal.json')), journalBytes);
 assert.deepEqual((await backup(f.root, journal.backup)).metadata, saved.metadata);
 assert.deepEqual(await recoveryInfo({ checkout: f.root, journalKey: journal.journalKey, repository: f.repository,
  fromCommit: f.v1.commit, toCommit: broken.commit }), { status: 'available', previous_head: owner.commit,
  checkout_name: 'owner-checkout', backup_name: journal.backup });
 const restored = await f.run(['upgrade', '--restore', journal.backup, '--json']);
 assert.equal(restored.code, 0, restored.stderr);
 assert.equal((await readJournal(f.root)).stage, 'rolled_back');
 assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), owner.commit);
 assert.deepEqual(await readFile(join(f.root, 'rer-upstream.json')), record);
 assert.equal(await readFile(marker, 'utf8'), 'Keep these exact owner bytes\n');
 assert.deepEqual((await f.sql('SELECT id, body FROM upgrade_records'))[0].results, [ownerRow]);
 assert.equal((await fetch(f.url + '/health')).status, 200);
 t.diagnostic(JSON.stringify({ interrupted, retry: result(retry), recovery: result(restored), ownerSourceAndDataKept: true }));
});
