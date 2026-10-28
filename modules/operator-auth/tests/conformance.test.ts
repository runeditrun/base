import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerOperatorAuthConformance } from '../conformance/index.mjs';
import { standaloneConformance } from './conformance-cases.mjs';

for (const [name, run] of standaloneConformance) test(name, run);

test('the reusable suite rejects an incomplete adapter instead of silently skipping its contract', () => {
  assert.throws(() => registerOperatorAuthConformance({ test, adapter: { open: undefined } as never }), /runtime adapter/);
});
