import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {buildContainer} from '../build.mjs';
import {deploymentSpec} from '../../delivery-producer/spec.mjs';
import {startHost} from '../host.mjs';

test('built container applies the same complete ordered migration inventory as delivery packaging and resumes it',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-container-migrations-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['src','migrations/core','migrations/base','migrations/import','migrations/updates'])await mkdir(join(root,path),{recursive:true});
 await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'src/server.ts'),"export default {async fetch(request,env){const {results}=await env.DB.prepare('SELECT value FROM notes ORDER BY id').all();return Response.json({status:'ok',notes:results.map(row=>row.value)});}};");
 await writeFile(join(root,'vite.config.mjs'),`
  import {cloudflare} from '@cloudflare/vite-plugin';
  export default {logLevel:'silent',plugins:[cloudflare({viteEnvironment:{name:'ssr'}})],
   environments:{ssr:{build:{outDir:'dist/server'}}},
   builder:{buildApp:async builder=>{await builder.build(builder.environments.ssr);}}};
 `);
 await writeFile(join(root,'wrangler.jsonc'),JSON.stringify({name:'container-migrations',main:'src/server.ts',compatibility_date:'2026-09-01',d1_databases:[{binding:'DB',database_name:'notes',database_id:'00000000-0000-0000-0000-000000000000',migrations_dir:'migrations/core'}]}));
 const sql=[
  ['core','0200_notes.sql','CREATE TABLE notes(id INTEGER PRIMARY KEY,value TEXT);'],
  ['base','0001_owner.sql',"INSERT INTO notes VALUES(1,'owner');"],
  ['import','0002_import.sql',"INSERT INTO notes VALUES(2,'imported');"],
  ['updates','0003_update.sql',"UPDATE notes SET value='updated' WHERE id=2;"],
 ];
 for(const [group,name,source] of sql)await writeFile(join(root,'migrations',group,name),source);
 const specInputs={migrationPrefix:'core-',extraMigrationDirectories:[
  {binding:'DB',path:'migrations/base',prefix:'base-'},
  {binding:'DB',path:'migrations/import',prefix:'import-'},
  {binding:'DB',path:'migrations/updates',prefix:'updates-'},
  {binding:'DB',path:'migrations/optional',optional:true},
 ],recovery:'Restore retained data.'};
 await writeFile(join(root,'packaging.json'),JSON.stringify({artifact:{specInputs}}));
 const result=await buildContainer(root,{engine:'workerd',declaration:{},output:join(root,'image')});
 const manifest=JSON.parse(await readFile(join(result.output,'app/container.json'),'utf8'));
 const canonical=(await deploymentSpec(root,specInputs)).migrations;
 assert.deepEqual(manifest.migrations.DB.map(({statements,...entry})=>({binding:'DB',...entry})),canonical);
 const data=join(root,'data');
 await mkdir(join(result.output,'app/dist/client'),{recursive:true});
 await mkdir(data);await writeFile(join(data,'host.lock'),'');
 // Start the actual packaged Worker twice on the same volume and use its HTTP door.
 for(let run=0;run<2;run++) {
  const host=await startHost({root:join(result.output,'app'),data,port:0,settings:{},automaticTicks:false});
  try {
   const response=await fetch('http://127.0.0.1:'+host.server.address().port+'/health');
   assert.equal(response.status,200);
   assert.deepEqual((await response.json()).notes,['owner','updated']);
  }finally{await host.close();}
 }
});
