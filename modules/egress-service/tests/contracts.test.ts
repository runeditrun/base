import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsc = fileURLToPath(new URL('../../../default-seed/node_modules/.bin/tsc', import.meta.url));

test('the service typechecks against workers-types and its binding satisfies the Penny, Vector and Spool contracts', () => {
  const result = spawnSync(tsc, ['-p', fileURLToPath(new URL('../tsconfig.json', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
