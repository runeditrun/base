import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, readFile, stat, writeFile } from 'node:fs/promises';
import { parseJsonc } from './jsonc.mjs';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import {createServer} from 'node:net';
import {localOperation} from '../onboarding/local/operation.mjs';

// The documented recovery path: export, reset, import the very file that export
// produced, and export again. The same file must always be accepted in place.
test('a file rer just exported imports in place after reset, repeatedly; shared or group-readable input is still refused', { timeout: 15 * 60_000 }, async t => {
 const seed = await portabilityFixture(t);
 // The app's Durable Object binding, as HappyToHelp declares one: the transfer never needs it.
 const wrangler = join(seed.root, 'wrangler.jsonc');
 await writeFile(wrangler, JSON.stringify({ ...parseJsonc(await readFile(wrangler, 'utf8')), durable_objects: { bindings: [{ name: 'CONVERSATIONS', class_name: 'ConversationSocket' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['ConversationSocket'] }] }, null, 2));
 await seed.run(['export', '--output', 'exports/empty.rer']);
 await seed.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('first',3,125,'café'),('second',2,75,NULL)");
 // A person's export prints no workerd warning and no receipt, and ends with one line naming the archive.
 const shown = await seed.text(['export', '--output', 'exports/shown.rer']);
 assert.doesNotMatch(shown.stdout + shown.stderr, /DurableObjectNamespace|ConversationSocket|contentHash|"tables"/);
 const receipt = (await seed.run(['export', '--output', 'exports/shown-data.rer'])).at(-1);
 const rowCount = receipt.tables.reduce((sum, table) => sum + table.count, 0);
 assert.ok(receipt.contentHash && rowCount >= 2, 'the receipt stays --json data');
 assert.match(shown.stdout.trimEnd().split('\n').at(-1), new RegExp(`^Exported the local copy to exports/shown\\.rer \\(\\d+(\\.\\d)? (B|KB|MB)\\): ${receipt.tables.length} tables, ${rowCount.toLocaleString('en-US')} rows$`));
 // A hosted address is refused before any effect, naming the command that exports it, never answered with this computer's copy.
 const hosted = await seed.text(['export', '--origin', 'https://example.invalid', '--output', 'exports/hosted.rer'], 2);
 assert.match(hosted.stderr, /https:\/\/example\.invalid[^]*npx wrangler d1 export \S+ --remote --output /);
 await assert.rejects(stat(join(seed.root, 'exports/hosted.rer')), { code: 'ENOENT' });
 const query = 'SELECT * FROM computed_entries ORDER BY id', rows = (await seed.data(query))[0].results;
 let previous;
 for (const round of [1, 2, 3]) {
  const name = `exports/round-${round}.rer`, exported = (await seed.run(['export', '--output', name])).at(-1);
  const status = await stat(join(seed.root, name));
  assert.equal(status.nlink, 1, 'export leaves one link to the archive');
  assert.equal(status.mode & 0o777, 0o600);
  await assert.rejects(stat(join(seed.root, `${name}.partial`)), { code: 'ENOENT' });
  if (previous) assert.equal(exported.contentHash, previous, 'the restored installation exports the same data');
  previous = exported.contentHash;
  await seed.run(['reset', '--yes']);
  assert.equal((await seed.run(['import', '--input', name, '--yes'])).at(-1).contentHash, exported.contentHash);
  assert.deepEqual((await seed.data(query))[0].results, rows);
 }
 // Negative controls: the check for a private, single-link input stays strict.
 await seed.run(['reset', '--yes']);
 await copyFile(join(seed.root, 'exports/round-1.rer'), join(seed.root, 'shared.rer'));
 await chmod(join(seed.root, 'shared.rer'), 0o600);
 await link(join(seed.root, 'shared.rer'), join(seed.root, 'shared.rer.partial'));
 await seed.run(['import', '--input', 'shared.rer', '--yes'], 4);
 await copyFile(join(seed.root, 'exports/round-1.rer'), join(seed.root, 'group.rer'));
 await chmod(join(seed.root, 'group.rer'), 0o640);
 await seed.run(['import', '--input', 'group.rer', '--yes'], 4);
});

test('local import and setup after import finish with a slow inspection and retain restored data', {timeout:10*60_000}, async t=>{
 const seed=await portabilityFixture(t,{generated:false}),slow={slow:true};
 await seed.run(['export','--output','exports/empty.rer']);
 await seed.data("INSERT INTO articles VALUES('retained','retained','Restored title','Owner content','2026-10-16')");
 await seed.run(['export','--output','exports/saved.rer']);
 await seed.run(['reset','--yes'],0,slow);
 // An empty, migrated destination still has state files for the injected
 // lsof timeout; importing into absent state would skip that query entirely.
 await seed.run(['export','--output','exports/destination-empty.rer']);
 const operation=await localOperation(seed.root);
 try{
  for(const args of [['import','--input','exports/saved.rer','--yes'],['setup','--owner-email','restored@example.test','--non-interactive']]){
   const refused=await seed.run(args,4,slow);
   assert.match(refused.find(row=>row.event==='error').message,new RegExp(`PID ${process.pid}`));
  }
 }finally{await operation.release();}
 await seed.run(['import','--input','exports/saved.rer','--yes'],0,slow);
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const setup=await seed.run(['setup','--owner-email','restored@example.test','--port',String(port),'--non-interactive'],0,slow);
 assert.ok(setup.some(row=>row.event==='setup-ready'));
 assert.deepEqual((await seed.data("SELECT title,body FROM articles WHERE id='retained'"))[0].results,[{title:'Restored title',body:'Owner content'}]);
 assert.deepEqual((await seed.data("SELECT email FROM oa_operators WHERE role='owner' AND status='active'"))[0].results,[{email:'restored@example.test'}]);
});
