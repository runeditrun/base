import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../migrations.mjs';
import { cloudflare } from '../provider.mjs';
import { hash } from '../validation.mjs';
import { providerFixture } from './provider-fixture.mjs';

const named = (name, sql) => ({ name, sql, sha256: hash(sql) });
const table = (name, columns = 'id TEXT PRIMARY KEY') => `CREATE TABLE ${name}(${columns});`;
// Shaped like a real seed's history: a release applied through 180, then a release
// that adds eleven migrations, nine of them sorting below rows already applied.
const released = [
  named('0001_accounts.sql', table('accounts')),
  named('0002_contacts.sql', table('contacts', 'id TEXT PRIMARY KEY, email TEXT, proof TEXT')),
  named('0003_notes.sql', table('notes', 'id TEXT PRIMARY KEY, contact TEXT, body TEXT, read_at TEXT')),
  named('124_note_read_index.sql', 'CREATE INDEX notes_read ON notes(read_at);'),
  named('125_contact_proof.sql', table('contact_proofs', 'contact TEXT PRIMARY KEY, proved_at TEXT')),
  named('129_owner_alerts.sql', table('owner_alerts')),
  named('180_account_security.sql', table('account_factors', 'account TEXT PRIMARY KEY, secret TEXT')),
];
const added = [
  named('124_contact_proof_guard.sql', "CREATE TRIGGER contact_proof_guard BEFORE UPDATE OF proof ON contacts WHEN NEW.proof IS NULL BEGIN SELECT RAISE(ABORT, 'proof kept'); END;"),
  named('126_restore_erasure.sql', table('erasures')),
  named('130_tickets.sql', table('tickets', 'id TEXT PRIMARY KEY, contact TEXT, status TEXT')),
  named('131_ticket_views.sql', 'CREATE VIEW open_tickets AS SELECT id FROM tickets WHERE status = \'open\';'),
  named('132_ticket_erasure.sql', 'ALTER TABLE erasures ADD COLUMN ticket TEXT;'),
  named('170_knowledge.sql', table('articles')),
  named('171_surveys.sql', table('surveys')),
  named('181_note_subjects.sql', 'ALTER TABLE notes ADD COLUMN subject TEXT;'),
  named('182_kit_retirement.sql', 'DROP TABLE owner_alerts;'),
  named('190_step_up.sql', table('step_ups')),
  named('191_ticket_history.sql', 'ALTER TABLE tickets ADD COLUMN conversation TEXT;'),
];
const sorted = list => [...list].sort((a, b) => a.name < b.name ? -1 : 1);
const current = sorted([...released, ...added]);

async function install(t, migrations) {
  const fixture = providerFixture();
  t.after(() => fixture.close());
  const api = cloudflare(fixture);
  const { uuid: id } = await api.request('/d1/database', { method: 'POST', body: { name: 'history-proof' } });
  const db = fixture.state.databases.at(-1).db;
  if (migrations) await migrate(api, id, migrations);
  const ledger = () => db.prepare('SELECT name,sha256,state FROM d1_migrations ORDER BY id').all().map(row => ({ ...row }));
  const schema = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT IN ('d1_migrations','sqlite_sequence') ORDER BY type,name").all().map(row => ({ ...row }));
  return { fixture, api, id, db, ledger, schema };
}

test('an upgrade adding migrations that sort below applied ones applies exactly the missing ones, by name, and the next deploy has nothing to do', async t => {
  const { fixture, api, id, ledger, schema } = await install(t, released);
  const before = ledger();
  const result = await migrate(api, id, current);
  assert.deepEqual(result.applied, added.map(x => x.name), 'pending is the build\'s unapplied migrations in name order');
  assert.deepEqual(ledger(), [...before, ...added.map(({ name, sha256 }) => ({ name, sha256, state: 'applied' }))], 'applied rows keep their ids; new rows follow');
  const fresh = await install(t, current);
  assert.deepEqual(schema(), fresh.schema(), 'the upgraded schema is a fresh install\'s');
  const writes = fixture.state.writes.length;
  assert.deepEqual((await migrate(api, id, current)).applied, [], 'the ledger it wrote is accepted as is');
  assert.equal(fixture.state.writes.length, writes);
  const later = [named('127_contact_merge.sql', table('merges')), named('192_audit.sql', table('audits'))];
  assert.deepEqual((await migrate(api, id, sorted([...current, ...later]))).applied, later.map(x => x.name), 'and the next release applies past it');
});

test('applied history this build does not record stays refused and writes nothing; a rolled-back claim on the next migration is retried; readback checks every name and digest', async t => {
  const { fixture, api, id, db, ledger } = await install(t, released);
  const claim = (migration, state = 'applying') => db.prepare('INSERT INTO d1_migrations(name,sha256,state) VALUES (?,?,?)').run(migration.name, migration.sha256, state);
  const refuses = async (migrations, label, claimed) => {
    const writes = fixture.state.writes.length, rows = ledger();
    await assert.rejects(migrate(api, id, migrations), error => error.message === 'changed-or-uncertain-migration-history' && error.unconfirmedClaim?.name === claimed, label);
    assert.equal(fixture.state.writes.length, writes, `${label}: nothing written`);
    assert.deepEqual(ledger(), rows);
  };
  await refuses(current.filter(x => x.name !== '129_owner_alerts.sql'), 'an applied name the build lacks');
  await refuses(current.map(x => x.name === '125_contact_proof.sql' ? named(x.name, `${x.sql}\n-- edited`) : x), 'changed bytes');
  const next = added[0];
  claim(added[5]);
  await refuses(current, 'a claim on a migration other than the build\'s first unapplied one', added[5].name);
  claim(next, 'applied');
  await refuses(current, 'an unconfirmed claim with applied rows after it');
  db.exec("DELETE FROM d1_migrations WHERE id > 7");
  // D1 rolled back the import of the next migration: its claim stays and its effects are absent.
  claim(next);
  const retried = await migrate(api, id, current);
  assert.deepEqual(retried.retried, [next.name]);
  assert.deepEqual(retried.applied, added.map(x => x.name));
  assert.ok(ledger().every(row => row.state === 'applied'));
  // The final readback fails on any name or digest it did not write.
  for (const [label, tamper] of [
    ['a changed digest', `UPDATE d1_migrations SET sha256='${hash('other')}' WHERE name='0002_contacts.sql'`],
    ['a lost row', "DELETE FROM d1_migrations WHERE name='0003_notes.sql'"],
    ['an unknown row', `INSERT INTO d1_migrations(name,sha256,state) VALUES ('199_unknown.sql','${hash('x')}','applied')`],
  ]) {
    const other = await install(t, released);
    let imports = 0;
    const tampering = { ...other.api, importSql: async (target, sql) => { await other.api.importSql(target, sql); if (++imports === added.length) other.db.exec(tamper); } };
    await assert.rejects(migrate(tampering, other.id, current), /migration-readback-mismatch/, label);
  }
});
