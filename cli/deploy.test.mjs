import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownerDeploy } from './deploy.mjs';

test('owner deploy dry run validates the kit artifact and declaration with zero fetch requests',async t=>{
 // Kit artifact data only; real application acceptance is in reference-journey.
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-deploy-kit-')));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['dist/server','dist/client','migrations/core'])await mkdir(join(root,path),{recursive:true});
 await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
 await writeFile(join(root,'dist/server/index.js'),'export default {}');await writeFile(join(root,'dist/client/index.html'),'artifact bytes');
 await writeFile(join(root,'migrations/core/0001_owner.sql'),'CREATE TABLE owner(id TEXT PRIMARY KEY);');
 const declaration={version:1,project:'tests/fixture',compatibilityDate:'2026-09-08',d1:[{binding:'DB'}]};
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 let builds=0,requests=0;const store={report:()=>{}};
 t.mock.method(globalThis,'fetch',()=>{requests++;throw Error('Provider request forbidden in dry run');});
 const deploy=ownerDeploy('deploy.json',{run:async(...args)=>{builds++;assert.equal(args.at(-1).verb,'build');assert.equal(args.at(-1).operationToken,'library-lock');}});
 const args={root,options:{dryRun:true},store,signal:new AbortController().signal,operationToken:'library-lock'};
 assert.deepEqual(await deploy(args),{dryRun:true,deployed:false});assert.equal(builds,1);assert.equal(requests,0);
 await writeFile(join(root,'deploy.json'),JSON.stringify({...declaration,d1:[]}));
 await assert.rejects(deploy(args),/undeclared-migration-binding/);assert.equal(requests,0);
});

test('owner deploy reports the failed provider step and completed creates without exposing credentials',async t=>{
 const {execFileSync}=await import('node:child_process');
 const {ownerProvider}=await import('../modules/deploy-kit/tests/owner-provider.mjs');
 const {lifecycleError}=await import('./errors.mjs');
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-deploy-errors-')));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['dist/server','dist/client','migrations/core'])await mkdir(join(root,path),{recursive:true});
 await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
 await writeFile(join(root,'dist/server/index.js'),'export default {}');
 await writeFile(join(root,'dist/client/index.html'),'artifact bytes');
 await writeFile(join(root,'migrations/core/0001_owner.sql'),'CREATE TABLE owner(id TEXT PRIMARY KEY);');
 await writeFile(join(root,'deploy.json'),JSON.stringify({version:1,project:'tests/fixture',compatibilityDate:'2026-09-08',d1:[{binding:'DB'}],r2:[{binding:'FILES'}],secrets:[{binding:'SESSION_SECRET',environment:'DEPLOY_PROOF_VALUE'}]}));
 await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');
 const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false',...args],{cwd:root,stdio:'pipe'});
 git('init','-q');git('add','.');git('commit','-qm','fixture');
 const names=['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','DEPLOY_PROOF_VALUE'],before=names.map(name=>process.env[name]);
 t.after(()=>names.forEach((name,i)=>{if(before[i]===undefined)delete process.env[name];else process.env[name]=before[i];}));
 for(const [step,method,path,kind='http'] of [
  ['create R2','POST',/\/r2\/buckets$/],
  ['migrate D1','POST',/\/d1\/database\/[^/]+\/query$/],
  ['upload Worker','PUT',/\/workers\/scripts\/[^/]+$/],
  ['migrate D1','POST',/\/d1\/database\/[^/]+\/query$/,'logical'],
  ['upload Worker','PUT',/\/workers\/scripts\/[^/]+$/,'transport'],
  ['upload Worker','POST',/\/workers\/assets\/upload$/,'transport'],
  ['migrate D1','POST',/\/d1\/database\/[^/]+\/query$/,'body-transport'],
  ['upload Worker','PUT',/\/workers\/scripts\/[^/]+$/,'body-transport'],
  ['upload Worker','POST',/\/workers\/assets\/upload$/,'body-transport'],
 ]){
  await rm(join(root,'.rer'),{recursive:true,force:true});
  const provider=ownerProvider();let failures=0,assetToken;
  const privateRow='query-row-must-not-be-diagnostic';
  Object.assign(process.env,{CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token,DEPLOY_PROOF_VALUE:'synthetic-private-deploy-value'});
  const transport=t.mock.method(globalThis,'fetch',async(input,init={})=>{
   if(init.method===method&&path.test(new URL(input).pathname)){
    failures++;
    if(new URL(input).pathname.endsWith('/assets/upload'))assetToken=init.headers.Authorization.slice('Bearer '.length);
    const values=[provider.token,provider.accountId,process.env.DEPLOY_PROOF_VALUE,assetToken].filter(Boolean);
    const message=`Deployment blocked\n${values.join(' ')}\n${values.map(value=>'x'.repeat(490)+value).join('\n')}`;
    if(kind==='transport')throw new TypeError('fetch failed',{cause:Object.assign(new Error(message),{code:'ECONNRESET'})});
    if(kind==='body-transport')return new Response(new ReadableStream({
     start(controller){controller.enqueue(new TextEncoder().encode(`{"success":true,"result":[{"value":"${privateRow}"}`));},
     pull(controller){controller.error(new TypeError('terminated',{cause:Object.assign(new Error(message),{code:'ECONNRESET'})}));},
    }),{status:200});
    if(kind==='logical')return Response.json({success:true,result:[
     {success:true,results:[{value:privateRow}],error:privateRow},
     {success:false,error:message,results:[{value:privateRow}],errors:[{code:7500,message:'Provider secondary reason'},{code:'invalid',message:{value:privateRow}}]},
    ]});
    return step==='migrate D1'?new Response(message,{status:400}):Response.json({success:false,errors:[{code:10042,message}]},{status:400});
   }
   return provider.fetch(input,init);
  });
  const store={state:{step:'complete'},report:()=>{}};let failure;
  try{
   await assert.rejects(ownerDeploy('deploy.json',{run:async()=>{}})({root,options:{},store}),asyncError=>{
    failure=asyncError;
    assert.ok(asyncError.message.includes(step));
    assert.ok(asyncError.message.includes(kind==='logical'?'d1-query-failed':kind.endsWith('transport')?'provider-transport-failed':'provider-http-400'));
    assert.match(asyncError.message,/Deployment blocked/);
    if(kind.endsWith('transport'))assert.match(asyncError.message,/ECONNRESET/);
    if(kind==='logical')assert.match(asyncError.message,/Provider secondary reason/);
    assert.match(asyncError.message,/D1:fixture-production-db/);
    if(step!=='create R2')assert.match(asyncError.message,/R2:fixture-production-files/);
    for(const value of [provider.token,provider.accountId,process.env.DEPLOY_PROOF_VALUE,assetToken].filter(Boolean)){
     assert.ok(!asyncError.message.includes(value));
     assert.ok(!asyncError.message.includes('x'.repeat(490)+value.slice(0,10)),'redaction runs before truncating a line through a credential');
    }
    assert.ok(!asyncError.message.includes(privateRow),'query results and successful rows are not diagnostic output');
    return true;
   });
   assert.equal((await lifecycleError(failure,store)).message,failure.message,'approved deploy cause survives lifecycle completion');
   assert.equal(failures,1,'the failed provider request is never retried');
   assert.equal(provider.state.databases.length,1);
   assert.equal(provider.state.buckets.length,step==='create R2'?0:1);
   assert.equal(provider.state.settings,null,'the failed attempt did not publish a Worker');
  }finally{transport.mock.restore();provider.close();}
 }
});
