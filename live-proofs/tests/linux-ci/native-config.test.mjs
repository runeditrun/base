import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBuildConfig } from './native-config.mjs';
import { validateBuildConfig } from '../../t016/artifact.mjs';

test('native defaults remain an exact expected contract with no additional effect authority', () => {
  const prepared = { name: 'qualification', main: 'src/server.ts', vars: { APP_ORIGIN: 'https://qualification.invalid' } };
  const expected = nativeBuildConfig(prepared);
  const emitted = { ...structuredClone(expected), main: 'index.js', no_bundle: true, assets: { directory: '../client' } };
  validateBuildConfig(expected, emitted);
  for (const change of [
    { services: [{ binding: 'OTHER', service: 'other-worker' }] },
    { configPath: '/tmp/unreviewed.json' }, { topLevelName: 'other-worker' },
    { dev: { ...expected.dev, ip: '0.0.0.0' } },
    { new_provider_binding: [] }, { no_bundle: false },
  ]) assert.throws(() => validateBuildConfig(expected, { ...emitted, ...change }));
  assert.deepEqual(prepared, { name: 'qualification', main: 'src/server.ts', vars: { APP_ORIGIN: 'https://qualification.invalid' } });
});
