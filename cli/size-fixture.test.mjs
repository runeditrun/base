import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { compileFixture } from './size/fixture.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

const run = promisify(execFile), rer = resolve(import.meta.dirname, '../bin/rer.mjs');
const exec = (args, env) => run(process.execPath, [rer, ...args], { env }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
const result = ({ stdout }) => stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.event === 'result');

// A parent table, a child table whose rows carry a JSON array, and a trigger that derives one row per child.
const migration = `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE items (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, label TEXT NOT NULL, tags_json TEXT NOT NULL CHECK (json_valid(tags_json)), owner_email TEXT NOT NULL);
CREATE TABLE item_log (item_id TEXT NOT NULL, account_id TEXT NOT NULL);
CREATE TRIGGER items_logged AFTER INSERT ON items BEGIN INSERT INTO item_log(item_id, account_id) VALUES (NEW.id, NEW.account_id); END;
`;
// An owner claim route that answers 303 with a session cookie, like a seed's setup-token claim.
const worker = `export default { async fetch(request, env) {
 const url = new URL(request.url);
 if (url.pathname === '/auth/bootstrap' && request.method === 'POST') {
  const body = await request.json().catch(() => ({}));
  if (!env.SETUP_TOKEN || body.token !== env.SETUP_TOKEN) return new Response('forbidden', { status: 403 });
  await env.DB.prepare('INSERT INTO users(id, email) VALUES(?, ?)').bind('owner', env.OWNER_EMAIL).run();
  return new Response(null, { status: 303, headers: { location: body.returnTo ?? '/', 'set-cookie': 'session=owner; Path=/; HttpOnly' } });
 }
 // The declared flow's route: rer size now runs it, so it must answer.
 if (url.pathname === '/') return new Response('home');
 return new Response('not found', { status: 404 });
} };
`;
const declaration = {
  schema: 1, database: 'DB', budget: { windowRows: 100000, timeoutSeconds: 120 },
  personas: { owner: { kind: 'owner' } },
  shape: { tables: [
    { table: 'accounts', rows: { small: 3, large: 30 }, values: { id: "printf('a%03d', n)", name: ":size || printf(' account %d', n)" } },
    // Account 1 has five items and accounts 2 and 3 two each, at both sizes.
    { table: 'items', rows: 9, parent: { table: 'accounts', histogram: { 5: 1, 2: 2 } }, values: {
      id: "printf('i%03d', n)", account_id: "printf('a%03d', p)", label: "printf('item:size %d', n)",
      tags_json: { jsonArray: { length: 'CASE WHEN n <= 5 THEN 3 ELSE 1 END', item: "'t' || k" } }, owner_email: ':owner_email' } },
  ] },
  flows: [{ name: 'home', persona: 'owner', request: { method: 'GET', path: '/' }, ceiling: 100 }],
};

// A built seed: a Worker with a D1 binding and the migration above, served by the seed's own Miniflare.
async function seed(t, { shape = declaration, owner = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-size-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/server/migrations'), { recursive: true });
  await symlink(resolve(import.meta.dirname, '../default-seed/node_modules'), join(root, 'node_modules'));
  const files = {
    'package.json': '{"type":"module"}', 'deploy.json': '{"version":1,"vars":{}}',
    'rer-setup.json': JSON.stringify({ fields: [], steps: owner ? [{ type: 'owner-claim', mode: 'setup-token', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN' }] : [] }),
    'dist/server/wrangler.json': JSON.stringify({ main: 'index.js', compatibility_date: '2026-09-08', d1_databases: [{ binding: 'DB', database_name: 'app', database_id: 'app', migrations_dir: 'migrations' }] }),
    'dist/server/index.js': worker, 'dist/server/migrations/0001.sql': migration, 'size-check.json': JSON.stringify(shape),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

test('rer size builds the declared shape at a small and a large size and reads back what it declared', { timeout: 120_000 }, async t => {
  const root = await seed(t), env = await isolatedQueue(t, process.env);
  const built = await exec(['size', '--cwd', root, '--json'], env);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  const { small, large } = result(built).size;
  for (const [size, expected] of [[small, { accounts: 3, items: 9 }], [large, { accounts: 30, items: 9 }]]) {
    assert.deepEqual(Object.fromEntries(size.tables.map(table => [table.table, table.declared])), expected);
    for (const table of size.tables) assert.equal(table.readBack, table.declared, `${table.table} reads back what was declared`);
    // The owner, the accounts, the items and one derived row per item: the trigger fired.
    assert.ok(size.totalRows >= 1 + expected.accounts + 2 * expected.items);
  }
  assert.ok(large.totalRows > small.totalRows, 'the large size holds more rows');
});

test('a NOT NULL violation names the size, the table and the column, and that size is not built', { timeout: 120_000 }, async t => {
  const broken = structuredClone(declaration);
  broken.shape.tables[1].values.label = 'NULL';
  const root = await seed(t, { shape: broken }), env = await isolatedQueue(t, process.env);
  const failed = await exec(['size', '--cwd', root, '--json'], env);
  assert.equal(failed.code, 1);
  const { small, large } = result(failed).size;
  assert.match(small.error, /small/);
  assert.match(small.error, /items/);
  assert.match(small.error, /label/);
  assert.equal(small.tables, undefined, 'a size that failed has no built result');
  assert.equal(large, undefined, 'the large size is not attempted after the small one failed');
});

test('a declaration that needs the owner is refused, naming both ways a seed declares one, when the seed declares neither', { timeout: 120_000 }, async t => {
  const root = await seed(t, { owner: false }), env = await isolatedQueue(t, process.env);
  const refused = await exec(['size', '--cwd', root], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /owner-claim/);
  assert.match(refused.stderr, /verification\.owner/);
});

test('the exported compiler spreads a histogram over parents, binds parameters outside quotes only, and is repeatable', () => {
  const shape = structuredClone(declaration);
  shape.shape.tables[0].rows = 4;
  shape.shape.tables[1].rows = 25;
  shape.shape.tables[1].parent = { table: 'accounts', histogram: { 16: 1, 3: 3 } };
  const built = compileFixture(shape, 'large', { now: 1, ownerEmail: 'owner@example.test' });
  assert.deepEqual(compileFixture(shape, 'large', { now: 1, ownerEmail: 'owner@example.test' }), built, 'the same inputs give the same statements');
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  for (const { sql, params } of built.statements) db.prepare(sql).run(...params);
  const children = db.prepare('SELECT account_id, count(*) AS n FROM items GROUP BY account_id ORDER BY account_id').all().map(row => ({ ...row }));
  assert.deepEqual(children, [{ account_id: 'a001', n: 16 }, { account_id: 'a002', n: 3 }, { account_id: 'a003', n: 3 }, { account_id: 'a004', n: 3 }]);
  // ':size' inside the label's string literal is text; the parameter outside it is bound.
  assert.equal(db.prepare("SELECT label FROM items WHERE id = 'i001'").get().label, 'item:size 1');
  assert.equal(db.prepare("SELECT name FROM accounts WHERE id = 'a001'").get().name, 'large account 1');
  assert.equal(db.prepare('SELECT DISTINCT owner_email AS e FROM items').get().e, 'owner@example.test');
  assert.equal(db.prepare("SELECT tags_json AS t FROM items WHERE id = 'i001'").get().t, '["t0","t1","t2"]');
  assert.equal(db.prepare("SELECT tags_json AS t FROM items WHERE id = 'i006'").get().t, '["t0"]');
  assert.throws(() => compileFixture({ shape: { tables: [{ table: 'accounts', rows: 1, values: { id: ':nope' } }] } }, 'small', { now: 1 }), /accounts\.id/);
});
