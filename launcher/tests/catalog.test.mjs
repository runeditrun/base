import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, parseArgs } from '../lib/options.mjs';
test('active defaults acquire their declared source and retired editions require an explicit source', () => {
  for (const seed of ['happytohelp', 'lamp', 'orbit']) {
    const options = parseArgs([seed, '--ref', 'a'.repeat(40)], '/tmp/owner');
    assert.ok(catalog[seed]);
    assert.equal(options.directory, `/tmp/owner/${seed}`);
    assert.equal(options.ref, 'a'.repeat(40));
  }
  for (const seed of ['ferry', 'beacon']) {
    assert.throws(() => parseArgs([seed]), /retired.*--repository/);
    for (const source of ['/tmp/trusted-source', 'https://example.invalid/source.git', 'ssh://git@example.invalid/source.git'])
      assert.equal(parseArgs([seed, '--repository', source]).repository, source);
    assert.equal(parseArgs([seed, '--resume']).resume, true);
  }
});
