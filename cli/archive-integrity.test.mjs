import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';
import { makePart, sha256 } from '../modules/portability/index.mjs';

test('rer import refuses altered restoration metadata before opening destination data, an untouched archive round-trips, and archive diff names an archive it cannot read', {timeout:10*60_000}, async t=>{
 const source=await portabilityFixture(t);
 await source.run(['export','--output','exports/empty.rer']);
 await source.data("INSERT INTO computed_entries(id,quantity,unit_price,label) VALUES('retained',3,125,'café')");
 const erased=await sha256('previously erased fixture row');
 await source.data(`INSERT INTO rer_portability_journal SELECT source_identity,'${erased}' FROM rer_portability_state; UPDATE rer_portability_state SET epoch=1`);
 const exported=(await source.run(['export','--output','exports/source.rer'])).at(-1);
 const bytes=await readFile(join(source.root,'exports/source.rer'));
 const original=bytes.toString().trim().split('\n').map(JSON.parse);
 // rer archive diff compares real archives; one it cannot read is named, with why and the
 // command to run next, and no stack.
 const changes=JSON.parse((await source.text(['archive','diff','exports/empty.rer','exports/source.rer'])).stdout);
 assert.ok(changes.tables.some(table=>table.added.length),'the retained row is an addition');
 await mkdir(join(source.root,'exports/folder.rer'));
 await writeFile(join(source.root,'exports/truncated.rer'),original.slice(0,-1).map(record=>JSON.stringify(record)).join('\n')+'\n');
 await writeFile(join(source.root,'exports/altered.rer'),[{...original[0],sourceIdentity:'altered'},...original.slice(1)].map(record=>JSON.stringify(record)).join('\n')+'\n');
 for(const [args,exit,failed] of [[['exports/absent.rer','exports/source.rer'],3,0],[['exports/source.rer','exports/folder.rer'],2,1],[['exports/source.rer','exports/truncated.rer'],1,1],[['exports/altered.rer','exports/source.rer'],1,0]]) {
  const {stderr}=await source.text(['archive','diff',...args],exit);
  assert.ok(stderr.includes(args[failed])&&!stderr.includes(args[1-failed])&&stderr.includes('rer archive diff'),stderr);
  assert.doesNotMatch(stderr,/^\s+at /m);
 }
 for(const field of ['sourceIdentity','epoch','journal','exportedAt','legacy']) {
  const target=await portabilityFixture(t),records=structuredClone(original),manifest=records[0];
  if(field==='sourceIdentity')manifest.sourceIdentity+='-altered';
  if(field==='epoch')manifest.epoch++;
  if(field==='journal')manifest.journal[0]=await sha256('altered erased row');
  if(field==='exportedAt')manifest.exportedAt=new Date(0).toISOString();
  if(field==='legacy'){manifest.version=1;delete records.at(-1).archiveHash;}
  // Recomputed part checksums must not substitute for the archive binding.
  for(let i=1;i<records.length-1;i++)records[i]=await makePart(records[i].index,records[i].items);
  await writeFile(join(target.root,'input.rer'),records.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  const refused=(await target.run(['import','--input','input.rer','--yes'],4)).find(event=>event.event==='error');
  // A refusal, not a failure; a version 1 archive is pointed at its recovery command.
  assert.equal(refused.code,'restore_refused');
  if(field==='legacy')assert.ok(refused.message.includes('rer import --legacy-v1'),refused.message);
  await assert.rejects(stat(join(target.root,'.wrangler/state')),{code:'ENOENT'},`${field}: no destination data or restore bookkeeping is written`);
 }
 const target=await portabilityFixture(t);
 await writeFile(join(target.root,'untouched.rer'),bytes,{mode:0o600});
 const imported=(await target.run(['import','--input','untouched.rer','--yes'])).at(-1);
 const second=(await target.run(['export','--output','exports/restored.rer'])).at(-1);
 assert.equal(imported.contentHash,exported.contentHash);
 assert.equal(second.contentHash,exported.contentHash);
 const query='SELECT * FROM computed_entries ORDER BY id';
 assert.deepEqual((await target.data(query))[0].results,(await source.data(query))[0].results);
});
