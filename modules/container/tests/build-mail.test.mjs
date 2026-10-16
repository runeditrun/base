import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {buildContainer} from '../build.mjs';
import {startHost} from '../host.mjs';

test('managed mail public image defaults tolerate legacy deploy secrets, runtime settings win, and credentials stay private',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-container-mail-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'src'));
 await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'src/server.ts'),"export default {fetch(request,env){return Response.json({provider:env.MAIL_PROVIDER,from:env.MAIL_FROM});}};");
 await writeFile(join(root,'vite.config.mjs'),`
  import {cloudflare} from '@cloudflare/vite-plugin';
  export default {logLevel:'silent',plugins:[cloudflare({viteEnvironment:{name:'ssr'}})],
   environments:{ssr:{build:{outDir:'dist/server'}}},
   builder:{buildApp:async builder=>{await builder.build(builder.environments.ssr);}}};
 `);
 const vars={MAIL_PROVIDER:'rer',MAIL_FROM:'',MAIL_RELAY_URL:''};
 const wrangler={name:'container-mail',main:'src/server.ts',compatibility_date:'2026-09-01',vars};
 const config=()=>writeFile(join(root,'wrangler.jsonc'),JSON.stringify(wrangler));
 await config();
 const specInputs={mail:{providers:['rer']},publicVariableNames:Object.keys(vars),secretNames:[],optionalSecretNames:['MAIL_API_KEY']};
 const packaging=()=>writeFile(join(root,'packaging.json'),JSON.stringify({artifact:{specInputs}}));
 await packaging();
 const declaration={secrets:['MAIL_FROM','MAIL_PROVIDER','MAIL_RELAY_URL','MAIL_API_KEY'].map(binding=>({binding,environment:binding}))};
 const image=join(root,'image');
 const build=()=>buildContainer(root,{engine:'workerd',declaration,output:image});
 await build();
 const manifest=JSON.parse(await readFile(join(image,'app/container.json'),'utf8'));
 assert.deepEqual(manifest.config.vars,vars);
 await mkdir(join(image,'app/dist/client'),{recursive:true});
 const data=join(root,'data');await mkdir(data);await writeFile(join(data,'host.lock'),'');
 const settings={RER_DEMO:'1',MAIL_PROVIDER:'development',MAIL_FROM:'Uptime demo <demo@demo.invalid>'};
 const host=await startHost({root:join(image,'app'),data,port:0,settings,automaticTicks:false});
 try {
  const response=await fetch('http://127.0.0.1:'+host.server.address().port+'/mail-config');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{provider:settings.MAIL_PROVIDER,from:settings.MAIL_FROM});
 }finally{await host.close();}
 wrangler.vars={...vars,MAIL_API_KEY:'test-only-mail-credential'};await config();
 // Even a mistaken public allowlist cannot turn the credential into image config.
 specInputs.publicVariableNames.push('MAIL_API_KEY');await packaging();
 await assert.rejects(build(),/Secret declared as an image variable: MAIL_API_KEY/);
 wrangler.vars=vars;await config();delete specInputs.mail;await packaging();
 await assert.rejects(build(),/Secret declared as an image variable: MAIL_FROM/);
});
