import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upgradeFixture, ownerRow } from './fixtures/upgrade/fixture.mjs';
import { localOperation } from '../../onboarding/local/operation.mjs';

test('rer upgrades a signed release while preserving owner source and existing data', { timeout: 20 * 60_000 }, async t => {
 const f = await upgradeFixture(t);
 await f.launch();
 const owner = await f.ownerCommit();
 await f.addRow();
 const upgraded = await f.run(['upgrade', '--to', f.v2.commit, '--anchors', f.anchors, '--json']);
 assert.equal(upgraded.code, 0, upgraded.stderr + upgraded.stdout);
 assert.equal(await readFile(join(f.root, owner.path), 'utf8'), owner.contents);
 assert.equal(await f.git(f.root, 'merge-base', '--is-ancestor', owner.commit, 'HEAD'), '');
 assert.deepEqual((await f.sql('SELECT id, body, edition FROM upgrade_records'))[0].results,
  [{ ...ownerRow, edition: 'upgraded' }], 'prior data survives the actual new migration');
 const committed = await f.git(f.root, 'show', 'HEAD:rer-upstream.json');
 assert.equal(JSON.parse(await readFile(join(f.root, 'RELEASE.json'), 'utf8')).version, '2.0.0');
 const installed = JSON.parse(committed);
 assert.deepEqual(JSON.parse(await readFile(join(f.root, 'rer-upstream.json'), 'utf8')), installed);
 assert.equal(installed.tag, f.v2.tag);
 assert.equal(installed.commit, f.v2.commit);
 assert.equal((await fetch(f.url + '/health')).status, 200);
 await assert.rejects(() => localOperation(f.root), { code: 'LOCAL_OPERATION_BUSY' }, 'the detached app owns its lock after upgrade exits');
 assert.equal((await f.run(['dev', '--detach', '--json'])).code, 0, 'the checkout can reuse the upgraded app');
});
