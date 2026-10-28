import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {managedEntries, managedZip} from './managed-data.mjs';
import {splitStatements} from '../../modules/portability/sql-text.mjs';

export async function managedOrderJourney(t, {managedSource, managedFixture}) {
 const {source} = await managedSource(t), target = await managedFixture(t);
 const entries = await managedEntries(source);
 const statements = splitStatements(entries.find(([name]) => name === 'data/d1/DB.sql')[1].toString());
 const child = statements.filter(sql => /^(?:CREATE TABLE|INSERT INTO) ["]?events["]?(?:\s|\()/i.test(sql.trim()));
 assert.equal(child.length, 2);
 const childFirst = [statements[0], ...child, ...statements.slice(1).filter(sql => !child.includes(sql))];
 function zip(statements) {
  const sql = Buffer.from(statements.join(';\n') + ';\n');
  return managedZip(entries.map(([name, value]) => {
   if (name === 'data/d1/DB.sql') return [name, sql];
   if (name === 'manifest.json' || name === 'data/d1/DB.json') {
    const metadata = JSON.parse(value), database = name === 'manifest.json' ? metadata.databases[0] : metadata;
    database.dumpBytes = sql.length; database.dumpSha256 = createHash('sha256').update(sql).digest('hex');
    return [name, JSON.stringify(metadata)];
   }
   return [name, value];
  }));
 }
 const input = join(target.root, 'exports/child-first.zip');
 await writeFile(input, zip(childFirst.filter(sql => !/^CREATE TABLE issues\b/i.test(sql.trim()))), {mode: 0o600});
 const refused = await target.text(['import', '--input', 'exports/child-first.zip', '--yes', '--non-interactive', '--no-queue'], 4);
 assert.match(refused.stderr, /managed_data_sql_refused/);
 await assert.rejects(stat(join(target.root, '.wrangler/state')), {code: 'ENOENT'});
 console.log('Missing parent: import exit=4 managed_data_sql_refused; destination absent');
 await writeFile(input, zip(childFirst), {mode: 0o600});
 await target.run(['import', '--input', 'exports/child-first.zip', '--yes', '--non-interactive', '--no-queue']);
 assert.deepEqual((await target.data('SELECT * FROM events'))[0].results, [{id: 'event-1', issue_id: 'issue-1', body: 'Retained event'}]);
 assert.deepEqual((await target.data('SELECT * FROM issues'))[0].results, [{id: 'issue-1', title: 'Retained issue'}]);
 console.log('Child CREATE/INSERT before parent CREATE: import exit=0; child and parent rows equal');
}
