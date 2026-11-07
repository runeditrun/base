import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../migrations.mjs';
import { cloudflare } from '../provider.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

// A long migration (an index over a million rows): D1 answers the ingest `active`,
// the import commits with its completion marker, and the next poll finds nothing
// running. `tamper` changes the ledger the way each negative case needs, after the commit.
const entry = (name, sql) => ({ name, sql, sha256: hash(sql) });
const notImporting = { success: false, error: 'Not currently importing anything.' };
async function setup(t, tamper = () => {}) {
  const fixture = providerFixture();
  t.after(() => fixture.close());
  const real = fixture.fetch, reply = result => Response.json({ success: true, errors: [], result });
  const fetch = async (input, init = {}) => {
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    if (!/\/import$/.test(new URL(input).pathname) || !['ingest', 'poll'].includes(body?.action)) return real(input, init);
    if (body.action === 'poll') return reply(notImporting);
    const done = await (await real(input, init)).json();
    assert.equal(done.result.status, 'complete');
    tamper(fixture.state.databases[0].db);
    return reply({ success: true, type: 'import', status: 'active', at_bookmark: 'fixture-bookmark', messages: [] });
  };
  const api = cloudflare({ ...fixture, fetch });
  const { uuid } = await api.request('/d1/database', { method: 'POST', body: { name: 'poll-proof' } });
  return { fixture, api, id: uuid, db: fixture.state.databases[0].db };
}
const first = entry('0001_notes.sql', 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT);');
const second = entry('0002_index.sql', 'CREATE INDEX notes_body ON notes(body);');

test('an import that finished before its first poll continues to the next migration', async t => {
  const { api, id, db } = await setup(t);
  const result = await migrate(api, id, [first, second]);
  assert.deepEqual(result.applied, [first.name, second.name]);
  assert.deepEqual(db.prepare('SELECT name,sha256,state FROM d1_migrations ORDER BY id').all().map(row => ({ ...row })),
    [first, second].map(({ name, sha256 }) => ({ name, sha256, state: 'applied' })));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='notes_body'").get().n, 1);
});

for (const [label, tamper] of [
  ['the ledger has no row for the migration', db => db.exec(`DELETE FROM d1_migrations WHERE name='${first.name}'`)],
  ['the ledger row is not applied', db => db.exec(`UPDATE d1_migrations SET state='applying' WHERE name='${first.name}'`)],
  ['the ledger row holds other bytes', db => db.exec(`UPDATE d1_migrations SET sha256='${'0'.repeat(64)}' WHERE name='${first.name}'`)],
]) {
  test(`a finished-looking import still fails as d1-import-failed when ${label}`, async t => {
    const { fixture, api, id } = await setup(t, tamper);
    await assert.rejects(migrate(api, id, [first, second]), error => error.message === 'd1-import-failed' && error.migration === first.name);
    assert.equal(fixture.state.writes.filter(write => write.path.endsWith('/import')).length, 1);
  });
}
