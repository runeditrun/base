import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

// The documented recovery path: export, reset, import the very file that export
// produced, and export again. The same file must always be accepted in place.
test('a file rer just exported imports in place after reset, repeatedly; shared or group-readable input is still refused', { timeout: 15 * 60_000 }, async t => {
 const seed = await portabilityFixture(t);
 await seed.run(['export', '--output', 'exports/empty.rer']);
 await seed.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('first',3,125,'café'),('second',2,75,NULL)");
 const query = 'SELECT * FROM computed_entries ORDER BY id', rows = (await seed.data(query))[0].results;
 let previous;
 for (const round of [1, 2, 3]) {
  const name = `exports/round-${round}.rer`, exported = (await seed.run(['export', '--output', name])).at(-1);
  const status = await stat(join(seed.root, name));
  assert.equal(status.nlink, 1, 'export leaves one link to the archive');
  assert.equal(status.mode & 0o777, 0o600);
  await assert.rejects(stat(join(seed.root, `${name}.partial`)), { code: 'ENOENT' });
  if (previous) assert.equal(exported.contentHash, previous, 'the restored installation exports the same data');
  previous = exported.contentHash;
  await seed.run(['reset', '--yes']);
  assert.equal((await seed.run(['import', '--input', name, '--yes'])).at(-1).contentHash, exported.contentHash);
  assert.deepEqual((await seed.data(query))[0].results, rows);
 }
 // Negative controls: the check for a private, single-link input stays strict.
 await seed.run(['reset', '--yes']);
 await copyFile(join(seed.root, 'exports/round-1.rer'), join(seed.root, 'shared.rer'));
 await chmod(join(seed.root, 'shared.rer'), 0o600);
 await link(join(seed.root, 'shared.rer'), join(seed.root, 'shared.rer.partial'));
 await seed.run(['import', '--input', 'shared.rer', '--yes'], 4);
 await copyFile(join(seed.root, 'exports/round-1.rer'), join(seed.root, 'group.rer'));
 await chmod(join(seed.root, 'group.rer'), 0o640);
 await seed.run(['import', '--input', 'group.rer', '--yes'], 4);
});
