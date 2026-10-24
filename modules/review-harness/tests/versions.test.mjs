import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PINS, resolveVersions } from '../index.mjs';
import { consumer, temporary } from './helpers.mjs';

const require = createRequire(join(consumer, 'package.json'));
async function project(t, wrong) {
  const directory = await temporary(t, 'review-versions-');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['@playwright/test', '@axe-core/playwright', 'axe-core']) {
    const target = join(directory, 'node_modules', name);
    await mkdir(join(target, '..'), { recursive: true });
    if (name === wrong || (wrong === 'axe-core' && name === '@axe-core/playwright')) {
      await mkdir(target);
      await writeFile(join(target, 'package.json'), JSON.stringify({ name, version: name === wrong ? '0.0.1' : PINS[name], main: 'index.cjs' }));
      await writeFile(join(target, 'index.cjs'), 'module.exports = {};');
    } else {
      const resolver = name === 'axe-core' ? createRequire(require.resolve('@axe-core/playwright')) : require;
      await symlink(name === 'axe-core' ? join(resolver.resolve(name + '/package.json'), '..') : await realpath(join(consumer, 'node_modules', name)), target);
    }
  }
  return directory;
}

for (const wrong of Object.keys(PINS)) {
  test(`wrong resolved ${wrong} is refused and names all expected pins`, async t => {
    const directory = await project(t, wrong);
    assert.throws(() => resolveVersions(directory), error => Object.entries(PINS).every(([name, version]) => error.message.includes(`${name} ${version}`)) && /mismatch/.test(error.message));
  });
}
test('missing dependencies are refused with pin guidance', () => {
  assert.throws(() => resolveVersions('/nonexistent-review-consumer'), /expected @playwright\/test 1\.63\.0, @axe-core\/playwright 4\.13\.0/);
});
