import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkSchema, validate } from './json-schema.mjs';
const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const seed = read('SEED.example.json');
const schema = read('SEED.schema.json');
const composition = { base: 'base', family: 'support', edition: 'lily', modules: ['support-email'] };
test('legacy manifests and purpose editions coexist without incumbent replacement claims', () => {
  checkSchema(schema);
  assert.deepEqual(validate(schema, seed), []);
  assert.deepEqual(validate(schema, { ...seed, composition, replaces: [] }), []);
  const purpose = { ...seed, composition }; delete purpose.replaces;
  assert.deepEqual(validate(schema, purpose), []);
});
test('composition rejects missing identity, duplicate modules and independent versions', () => {
  for (const invalid of [{ ...composition, edition: '' }, { ...composition, modules: ['email', 'email'] }, { ...composition, version: '1.0.0' }, { family: 'support' }]) {
    assert.ok(validate(schema, { ...seed, composition: invalid }).length);
  }
});
test('assembly schema example validates', () => {
  const descriptor = read('COMPOSITION.schema.json'); checkSchema(descriptor);
  assert.deepEqual(validate(descriptor, read('COMPOSITION.example.json')), []);
});

test('uniqueItems compares JSON objects independent of property order', () => {
  assert.ok(validate({ type: 'array', uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).length);
  assert.deepEqual(validate({ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 2 }]), []);
});
