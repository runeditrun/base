import { caseRows } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrations, migrate } from '../migrations.mjs';
import { deploy } from '../deploy.mjs';
import { defaultStagePlan } from '../default-stage.mjs';
import { cloudflare } from '../provider.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

const emptyCaseRows = [];
const emptyCase = (name, run) => emptyCaseRows.push({name,run});

const migration = (sql, name = '0002_empty.sql') => ({ name, sql, sha256: hash(sql) });
const schema = migration('CREATE TABLE retained(value TEXT);', '0001_schema.sql');
const cases = [
  ['line comment without newline', '-- no executable SQL'],
  ['line comment with newline', '-- no executable SQL\n'],
  ['multiple line comments', '-- first\n-- second\n'],
  ['block comment', '/* SELECT 1; BEGIN; END; */'],
  ['adjacent block comments', '/**//* ; */'],
  ['mixed comments and whitespace', ' \t/* SELECT 1; */\n-- final comment'],
  ['BOM and CRLF comments', '\uFEFF/* comment */\r\n-- comment\r\n'],
];

for (const [label, sql] of cases) {
  emptyCase(`deployment rejects ${label} before any provider request or migration claim`, async t => {
    const fixture = providerFixture();
    t.after(() => fixture.close());
    const api = cloudflare(fixture);
    const migrations = [schema, migration(sql)];
    const original = structuredClone(migrations);
    assert.throws(() => validateMigrations(migrations), /invalid-migration-bytes/);
    await assert.rejects(migrate(api, 'not-contacted', migrations), /invalid-migration-bytes/);
    await assert.rejects(migrate(api, 'not-contacted', migrations, { apply: false }), /invalid-migration-bytes/);
    assert.deepEqual(fixture.state.calls, []);
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(migrations, original);

    // The same untouched provider proves the public deploy door enforces the refusal too.
    const source = 'export default {scheduled() {},fetch(){return new Response("test")}}';
    const artifact = {
      version: 1, source: { sha: '1'.repeat(40), tree: '2'.repeat(40) }, run: { id: '12345', attempt: '1' },
      main: 'index.js', modules: [{ path: 'index.js', base64: Buffer.from(source).toString('base64'), sha256: hash(source) }],
      assets: [], migrations: [schema, migration(sql)].map(row => ({ binding: 'DB', ...row })),
    };
    const args = { api: cloudflare(fixture), plan: defaultStagePlan(artifact), artifact, artifactSha256: hash(artifact), fetch: fixture.fetch };
    await assert.rejects(deploy(args), /invalid-migration-bytes/);
    assert.deepEqual(fixture.state.calls, []);
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(fixture.state.databases, []);
  });
}

test('comment-only migrations are refused before any provider request or claim', async (t) => {
  await caseRows(t, emptyCaseRows.map(({name,run}) => [name,run]));
});
