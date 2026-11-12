import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { stateBytes } from './portability-progress.mjs';

test('rer export does not forecast remaining time from allocated database space', { timeout: 5 * 60_000 }, async t => {
 const seed = await portabilityFixture(t);
 await seed.run(['export', '--output', 'exports/empty.rer']);
 // Deleted values leave allocated SQLite pages: local state size is not the
 // amount of live data that the archive will contain.
 await seed.data("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO computed_entries(id,quantity,unit_price,label) SELECT 'deleted' || i,1,1,hex(zeroblob(160000)) FROM n; DELETE FROM computed_entries WHERE id LIKE 'deleted%'");
 await seed.data("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000) INSERT INTO computed_entries(id,quantity,unit_price,label) SELECT 'row' || i,i,2,'Invoice' FROM n");
 const allocated = await stateBytes(join(seed.root, '.wrangler/state'));
 const shown = await seed.text(['export', '--output', 'exports/small.rer']);
 const actual = (await stat(join(seed.root, 'exports/small.rer'))).size;
 assert.ok(allocated > actual * 10, 'fixture has far more allocated space than live archive data');
 const building = shown.stderr.split('\n').filter(line => /Building/.test(line));
 assert.ok(building.length >= 2, 'building progress is captured');
 const unknown = shown.stderr.split('\n').filter(line => /Exporting.*local data|Building/.test(line));
 assert.doesNotMatch(unknown.join('\n'), /\bmin(?:ute)?s?\b|\bhours?\b/i, 'allocated space must not yield an export duration');
 assert.doesNotMatch(building.join('\n'), /\bleft\b|\bremaining\b|\bETA\b/i, 'unknown archive size must not yield a time forecast');
});
