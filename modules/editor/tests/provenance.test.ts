import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
test('all eight vendored dependency files match recorded service provenance', () => {
  const root = new URL('../', import.meta.url);
  const provenance=JSON.parse(readFileSync(new URL('provenance.json',root),'utf8'));
  assert.match(provenance.revision,/^[a-f0-9]{40}$/);
  assert.equal(Object.keys(provenance.sha256).length,8);
  for(const [path,hash] of Object.entries(provenance.sha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex'),hash,path);
});
