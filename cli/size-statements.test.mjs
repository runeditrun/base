import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), rer = resolve(import.meta.dirname, '../bin/rer.mjs'), step = resolve(import.meta.dirname, 'size/verify-step.mjs');
const exec = (file, args) => run(process.execPath, [file, ...args]).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
const result = ({ stdout }) => stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'result');

const schema = 'CREATE TABLE totals (id TEXT PRIMARY KEY, total INTEGER NOT NULL);\nCREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);\nCREATE TABLE audit (n INTEGER);\n';
// A chain of n CTEs, each reading the one before: n + 1 FROM items once expanded.
const chain = n => `WITH c0 AS (SELECT id AS n FROM items), ${Array.from({ length: n }, (_, i) => `c${i + 1} AS (SELECT n FROM c${i})`).join(', ')} SELECT n FROM c${n}`;
const nestedExists = n => Array.from({ length: n }, () => 'SELECT 1 FROM items WHERE EXISTS (').join('') + 'SELECT 1' + ')'.repeat(n);

// A built checkout (dist/server/wrangler.json, one D1 binding) with the given migrations.
async function build(t, migrations) {
  // The migration reader refuses a path through a symlink, which macOS temp folders are.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-size-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/server/migrations'), { recursive: true });
  await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB', database_name: 'app', database_id: 'app', migrations_dir: 'migrations' }] }));
  for (const [name, sql] of Object.entries(migrations)) await writeFile(join(root, 'dist/server/migrations', name), sql);
  return root;
}
async function statementsFile(root, statements, name = 'statements.json') {
  const path = join(root, name);
  await writeFile(path, JSON.stringify({ statements, ignored: true }));
  return path;
}

test('rer size fails a statement D1 would refuse and passes a plain keyed read', async t => {
  const root = await build(t, { '0001_schema.sql': schema });
  const migrations = join(root, 'dist/server/migrations'), refused = { 'chain of 99 CTEs': chain(99), '13 nested EXISTS': nestedExists(13) };
  const file = await statementsFile(root, [...Object.entries(refused).map(([name, sql]) => ({ name, sql })), { name: 'keyed read', sql: 'SELECT label FROM items WHERE id = ?1' }]);
  const failing = await exec(rer, ['size', '--statements', file, '--migrations', migrations, '--json']);
  assert.equal(failing.code, 1);
  assert.deepEqual(result(failing).statements.filter(statement => !statement.ok).map(statement => statement.name), Object.keys(refused));
  assert.equal(result(failing).statements.find(statement => statement.name === 'keyed read').ok, true);
  const passing = await exec(rer, ['size', '--statements', await statementsFile(root, [{ name: 'keyed read', sql: 'SELECT label FROM items WHERE id = ?1' }], 'plain.json'), '--migrations', migrations]);
  assert.equal(passing.code, 0);
  const human = await exec(rer, ['size', '--statements', file, '--migrations', migrations]);
  for (const name of Object.keys(refused)) assert.match(human.stdout, new RegExp(name));
  assert.doesNotMatch(human.stdout, /keyed read/);
});

test('rer size measures an upsert and an UPDATE ... RETURNING, and names a statement SQLite cannot compile', async t => {
  const root = await build(t, { '0001_schema.sql': schema });
  const file = await statementsFile(root, [
    { name: 'upsert', sql: 'INSERT INTO totals(id, total) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET total = total + excluded.total' },
    { name: 'update returning', sql: 'UPDATE totals SET total = total + 1 WHERE id = ?1 RETURNING id, total' },
    { name: 'misspelt column', sql: 'SELECT labell FROM items' },
  ]);
  const checked = await exec(rer, ['size', '--statements', file, '--migrations', join(root, 'dist/server/migrations'), '--json']);
  assert.equal(checked.code, 1);
  const [upsert, update, misspelt] = result(checked).statements;
  assert.deepEqual([upsert.ok, upsert.error, update.ok, update.error], [true, undefined, true, undefined]);
  assert.equal(misspelt.ok, false);
  assert.match(misspelt.error, /labell/);
});

test('verify\'s size step fails naming a trigger that names too many FROM items, and passes without it', async t => {
  const trigger = `CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN\n INSERT INTO audit(n) ${chain(119)};\nEND;\n`;
  const failing = await build(t, { '0001_schema.sql': schema, '0002_audit.sql': trigger });
  const refused = await exec(step, [failing]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /items_audit/);
  assert.equal((await exec(rer, ['size', '--cwd', failing])).code, 1);
  const passing = await build(t, { '0001_schema.sql': schema });
  assert.equal((await exec(step, [passing])).code, 0);
  assert.equal((await exec(rer, ['size', '--cwd', passing])).code, 0);
  // No build and no --migrations: exit 3.
  const bare = await realpath(await mkdtemp(join(tmpdir(), 'rer-size-bare-')));
  t.after(() => rm(bare, { recursive: true, force: true }));
  assert.equal((await exec(rer, ['size', '--cwd', bare])).code, 3);
  assert.equal((await exec(rer, ['size', '--cwd', bare, '--migrations', join(failing, 'dist/server/migrations')])).code, 1);
});
