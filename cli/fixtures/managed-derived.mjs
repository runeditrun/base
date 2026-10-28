import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './portability.mjs';
import { managedEntries, managedZip } from './managed-data.mjs';
import { splitStatements } from '../../modules/portability/sql-text.mjs';

const virtual = "CREATE VIRTUAL TABLE inbox_message_search USING fts5(body, content='messages', content_rowid='id');";
const migration = `CREATE TABLE oa_operators(id TEXT PRIMARY KEY);
CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
${virtual}
CREATE TRIGGER inbox_message_search_insert AFTER INSERT ON messages BEGIN
 INSERT INTO inbox_message_search(rowid,body) VALUES(NEW.id,NEW.body);
END;
CREATE TRIGGER inbox_message_search_delete AFTER DELETE ON messages BEGIN
 INSERT INTO inbox_message_search(inbox_message_search,rowid,body) VALUES('delete',OLD.id,OLD.body);
END;
CREATE TRIGGER inbox_message_search_update AFTER UPDATE ON messages BEGIN
 INSERT INTO inbox_message_search(inbox_message_search,rowid,body) VALUES('delete',OLD.id,OLD.body);
 INSERT INTO inbox_message_search(rowid,body) VALUES(NEW.id,NEW.body);
END;
CREATE TABLE z_parent(id INTEGER PRIMARY KEY);
CREATE TABLE a_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES z_parent(id));
`;

async function fixture(t) {
 const f = await portabilityFixture(t, { generated: false });
 await rm(join(f.root, 'migrations/core'), { recursive: true });
 await mkdir(join(f.root, 'migrations/core'));
 await writeFile(join(f.root, 'migrations/core/0999_messages.sql'), migration);
 const adapter = join(f.root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('policy: portabilityPolicy',
  "policy: { product: 'managed-derived-fixture', derivedTables: ['inbox_message_search'] }"));
 return f;
}

// These are public CLI imports and exports, extending the existing Managed
// journey without adding test registrations or implementation/pin assertions.
export async function managedDerivedJourney(t) {
 const source = await fixture(t), target = await fixture(t);
 await source.run(['export', '--output', 'exports/empty.rer']);
 await source.data("INSERT INTO messages VALUES(1,'restored lantern'); INSERT INTO z_parent VALUES(7); INSERT INTO a_child VALUES(3,7)");
 // Preserve every migration's file identity and application order.
 const native = (await source.data('SELECT name FROM d1_migrations ORDER BY id'))[0].results;
 const ledger = await Promise.all(native.map(async ({ name }) => ({
  name, sha256: createHash('sha256').update(await readFile(join(source.root, 'migrations/core', name))).digest('hex'),
 })));
 await source.data(`CREATE TABLE rer_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO rer_migrations(name,sha256) VALUES ${ledger.map(row => "('" + row.name + "','" + row.sha256 + "')").join(',')}; DROP TABLE d1_migrations`);
 const kinds = (await source.data('PRAGMA table_list'))[0].results;
 const omitTables = kinds.filter(row => ['virtual', 'shadow'].includes(row.type)).map(row => row.name);
 const entries = await managedEntries(source, { omitTables });
 const rewrite = transform => {
  const data = Buffer.from(transform(entries.find(([name]) => name === 'data/d1/DB.sql')[1].toString()));
  return managedZip(entries.map(([name, value]) => {
   if (name === 'data/d1/DB.sql') return [name, data];
   if (['manifest.json', 'data/d1/DB.json'].includes(name)) {
    const metadata = JSON.parse(value), database = name === 'manifest.json' ? metadata.databases[0] : metadata;
    database.dumpBytes = data.length; database.dumpSha256 = createHash('sha256').update(data).digest('hex');
    return [name, JSON.stringify(metadata)];
   }
   return [name, value];
  }));
 };
 const input = join(target.root, 'exports/managed.zip'), args = ['import', '--input', 'exports/managed.zip', '--yes'];
 for (const [name, transform, reason] of [
  ['declared virtual DDL in dump', sql => sql + virtual, 'managed_data_sql_refused'],
  ['undeclared virtual DDL in dump', sql => sql + 'CREATE VIRTUAL TABLE rogue_search USING fts5(body);', 'managed_data_sql_refused'],
  ['missing derived triggers', sql => splitStatements(sql).filter(statement => !/CREATE TRIGGER inbox_message_search_/i.test(statement)).join(';\n') + ';', 'managed_data_schema_incompatible'],
  ['ordinary table posing as derived index', sql => sql + 'CREATE TABLE inbox_message_search(body TEXT);', 'managed_data_schema_incompatible'],
 ]) {
  await writeFile(input, rewrite(transform), { mode: 0o600 });
  const refused = await target.text(args, 4);
  assert.ok(refused.stderr.includes(reason), refused.stderr);
  await assert.rejects(stat(join(target.root, '.wrangler/state')), { code: 'ENOENT' });
  t.diagnostic(name + ': ' + refused.stderr.trim());
 }
 await writeFile(input, managedZip(entries), { mode: 0o600 });
 const imported = (await target.run(args)).at(-1);
 assert.equal(imported.ok, true);
 const triggers = imported.managedSchema.inventory.find(row => row.type === 'trigger');
 assert.ok(triggers.matched >= 3);
 assert.equal(triggers.accounted, 0);
 const search = word => target.data("SELECT rowid FROM inbox_message_search WHERE inbox_message_search MATCH '" + word + "'");
 assert.deepEqual((await search('lantern'))[0].results, [{ rowid: 1 }]);
 assert.deepEqual((await target.data('SELECT a_child.id,parent_id FROM a_child JOIN z_parent ON z_parent.id=a_child.parent_id'))[0].results, [{ id: 3, parent_id: 7 }]);
 t.diagnostic('derived table omitted, three triggers retained: managedSchema + managedCompatibility + restore accepted; MATCH lantern -> rowid 1');
 t.diagnostic('N5 child a_child sorts before z_parent: Managed ZIP restore accepted; child 3 -> parent 7');
 await target.data("UPDATE messages SET body='updated beacon' WHERE id=1");
 assert.deepEqual((await search('lantern'))[0].results, []);
 assert.deepEqual((await search('beacon'))[0].results, [{ rowid: 1 }]);
 await target.data('DELETE FROM messages WHERE id=1');
 assert.deepEqual((await search('beacon'))[0].results, []);
 await target.data("INSERT INTO messages VALUES(2,'fresh lantern')");
 assert.deepEqual((await search('lantern'))[0].results, [{ rowid: 2 }]);
 t.diagnostic('restored FTS insert/update/delete triggers: all search results match current messages');
 // A malformed native schema still reaches normalization through the public
 // exporter, but its SQLite diagnostic must not escape as an unclassified error.
 await source.data('DROP TABLE inbox_message_search');
 const broken = await source.text(['export', '--output', 'exports/broken.rer'], 4);
 assert.match(broken.stderr, /copy_normalization_failed/);
 assert.doesNotMatch(broken.stderr, /no such table|error in trigger/);
 t.diagnostic('dangling trigger normalization: ' + broken.stderr.trim());
}
