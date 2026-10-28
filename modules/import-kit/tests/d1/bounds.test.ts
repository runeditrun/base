import { caseRows, type CaseRow } from "../helpers/case-row.ts";
const familyRows: CaseRow[][] = [[]];
import test from 'node:test';
import assert from 'node:assert/strict';
import { packGuards, checkSql } from '../../src/d1/budget.ts';
import { jsonChunks, SNAPSHOT_BYTES } from '../../src/d1/sets.ts';
import { guard, sql } from '../../src/d1/database.ts';

familyRows[0].push(['JSON snapshot boundaries preserve quotes, Unicode, null, zero and false exactly', () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ i, text: '🌱"\\'.repeat(80), nullable: null, zero: 0, boolean: false }));
  const chunks = jsonChunks(rows);
  assert.ok(chunks.length > 1); assert.deepEqual(chunks.flatMap(chunk => JSON.parse(chunk)), rows);
  assert.ok(chunks.every(c => Buffer.byteLength(c) <= SNAPSHOT_BYTES));
}]);
familyRows[0].push(['atomic assertion packing respects binding and UTF-8 SQL ceilings', () => {
  const packed = packGuards(Array.from({ length: 101 }, (_, i) => guard(sql('1=?', i))));
  assert.equal(packed.reduce((n, p) => n + p.params!.length, 0), 101);
  assert.ok(packed.every(p => p.params!.length <= 100 && Buffer.byteLength(p.sql) <= 100000));
  assert.throws(() => checkSql(sql('x'.repeat(100001))), /IMPORT_D1_STATEMENT_LIMIT/);
  assert.throws(() => checkSql(sql('SELECT ?', ...Array(101).fill(0))), /IMPORT_D1_STATEMENT_LIMIT/);
  assert.throws(() => checkSql(sql('SELECT ?', '🌱'.repeat(500001))), /IMPORT_D1_VALUE_LIMIT/);
}]);

 test("d1 bounds preserves its public behavior across supported inputs and refusals", async t => { await caseRows(t, familyRows[0]); });
