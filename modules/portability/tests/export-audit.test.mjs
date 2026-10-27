import { runCases } from './cases.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createPortability } from '../index.mjs';
import { exportArchive } from '../files.mjs';
import { runtime, seed } from './helpers.mjs';
import { fixturePolicy } from './fixture-policy.mjs';

test('direct file export records seed audit atomically and refuses callback or audit SQL failure', async t => {
  const f = await runtime(t); await seed(f);
  await f.db.prepare(`CREATE TABLE operation_audit(
    id TEXT PRIMARY KEY, actor_id TEXT, scope TEXT NOT NULL, action TEXT NOT NULL, feature TEXT NOT NULL
  )`).run();
  const events = [], path = join(f.directory, 'installation.rer');
  let failure = 'callback';
  const service = await createPortability({ db: f.db, buckets: { FILES: f.bucket },
    policy: { ...fixturePolicy, excludeTables: [...fixturePolicy.excludeTables, 'operation_audit'] },
    onExport(event) {
      events.push(event);
      if (failure === 'callback') throw Error('audit callback refused');
      const insert = [`INSERT INTO operation_audit(id,actor_id,scope,action,feature)
        VALUES(?,?,?,'installation.export','rer export')`, [event.id, event.actor, event.scope]];
      // The second insert fails after the first wrote: both must roll back with the job and snapshots.
      return failure === 'sql' ? [insert, insert] : [insert];
    },
  });
  await runCases(t, Array.from(['callback', 'sql'], (rowValue, rowIndex) => [`${t.name}: rowValue row ${rowIndex + 1}`, async t => {failure = rowValue;

    await assert.rejects(exportArchive(service, path), failure === 'callback' ? /audit callback refused/ : /UNIQUE constraint failed/);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM operation_audit').first()).n, 0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM rer_portability_jobs').first()).n, 0);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'rer_portability_snap_*'").first()).n, 0);
    await assert.rejects(stat(path), { code: 'ENOENT' });
}]));
  failure = null;
  const receipt = await exportArchive(service, path);
  assert.ok(receipt.archiveHash);
  assert.ok((await stat(path)).size > 0);
  const { results } = await f.db.prepare('SELECT * FROM operation_audit').all();
  assert.deepEqual(results, [{ id: events.at(-1).id, actor_id: null, scope: 'installation', action: 'installation.export', feature: 'rer export' }]);
  assert.deepEqual(events.at(-1), { id: results[0].id, actor: null, scope: 'installation' });
  assert.equal(await service.actor(results[0].id), 'direct');
});
