import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portabilityFixture } from './fixtures/portability.mjs';

test('rer import applies a seed safety policy and shows its counts to the owner, with named refusals', {timeout:180_000}, async t=>{
 const source=await portabilityFixture(t,{generated:false}),target=await portabilityFixture(t,{generated:false});
 for(const fixture of [source,target])await writeFile(join(fixture.root,'migrations/core/0999_automations.sql'),
  'CREATE TABLE automations(id TEXT PRIMARY KEY,title TEXT,status TEXT,token TEXT);');
 await source.run(['export','--output','exports/empty.rer']);
 await source.data("INSERT INTO automations VALUES('a','Morning digest','active','fixture-only'),('b','Invoice reminder','active','fixture-only'),('c','Approval replay','active',NULL)");
 await source.run(['export','--output','exports/source.rer']);
 await copyFile(join(source.root,'exports/source.rer'),join(target.root,'exports/source.rer'));
 const adapter=join(target.root,'scripts/installer/local.mjs');
 await writeFile(adapter,(await readFile(adapter,'utf8')).replace('policy: portabilityPolicy',"policyModule: 'scripts/installer/safety.mjs'"));
 const policy=join(target.root,'scripts/installer/safety.mjs');
 const declare=map=>writeFile(policy,`import {portabilityPolicy} from '../../src/core/platform/portability-policy.mjs';
export default {...portabilityPolicy,importSafety:{automations:{status:['inactive'],token:[null]}},importRow(table,row){${map}}};\n`);
 const input=['import','--input','exports/source.rer','--yes'];
 await declare("return {...row,status:'inactive',title:'changed'};");
 const refused=await target.text(input,4);
 assert.match(refused.stderr,/automations:title/);
 assert.doesNotMatch(refused.stdout+refused.stderr,/fixture-only/);
 await declare("return {...row,status:'inactive',token:null};");
 const imported=await target.text(input);
 assert.match(imported.stdout,/3 automations imported with status="inactive"/);
 assert.match(imported.stdout,/2 automations imported with token=null/);
 const [state]=await target.data('SELECT status,token FROM automations');
 assert.ok(state.results.every(row=>row.status==='inactive' && row.token===null));
 const jobs=(await target.data("SELECT metadata FROM rer_portability_jobs WHERE kind='import' AND phase='complete'"))[0].results;
 assert.deepEqual(JSON.parse(jobs[0].metadata).safetyChanges,[
  {table:'automations',column:'status',value:'inactive',rows:3},
  {table:'automations',column:'token',value:null,rows:2},
 ]);
});
