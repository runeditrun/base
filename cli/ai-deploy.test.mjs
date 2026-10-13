import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { packageBuild } from '../modules/deploy-kit/prepare.mjs';
import { ownerPlan } from '../modules/deploy-kit/owner.mjs';

test('deploy, dry run and artifact/plan preparation refuse a local Models dev key before any build or provider request', async t => {
  const seed = await portabilityFixture(t, { generated: false });
  await mkdir(join(seed.root, '.rer/local'), { recursive: true, mode: 0o700 });
  await writeFile(join(seed.root, '.rer/local/models.json'), '{}\n', { mode: 0o600 });
  for (const flags of [[], ['--dry-run'], ['--platform', 'container'], ['--platform', 'container', '--dry-run']]) {
    const result = await seed.run(['deploy', ...flags], 4);
    assert.match(result.find(x => x.event === 'error').message, /local-only key file/);
  }
  await assert.rejects(readdir(join(seed.root, 'dist')), { code: 'ENOENT' });
  await assert.rejects(packageBuild({ root: seed.root, productDirectory: '' }), /local-only-models-file/);
  assert.throws(() => ownerPlan({ project: 'fixture', environment: 'production' }, { version: 1, vars: { RER_MODELS_KEY: 'synthetic' } }, {}), /local-only-binding/);
});
