import test from 'node:test';
import assert from 'node:assert/strict';
import { d1Preflight } from '../modules/container/adapters/d1-limits.mjs';

const columns = count => Array.from({ length: count }, (_, index) => `${index} AS c${index}`).join(', ');

test('a CTE materialization hint is not a function call, but a real call with too many arguments is refused', () => {
  for (const hint of ['MATERIALIZED', 'NOT MATERIALIZED']) {
    d1Preflight(`CREATE VIEW v AS WITH part0 AS ${hint} (SELECT ${columns(40)}) SELECT * FROM part0`);
  }
  const args = Array.from({ length: 33 }, (_, index) => index).join(', ');
  assert.throws(() => d1Preflight(`SELECT coalesce(${args})`), /SQL function arguments maximum 32, measured 33/);
});
