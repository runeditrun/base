import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownerDeploy } from './deploy.mjs';

test('owner deploy dry run validates the kit artifact and declaration with only provider reads',async t=>{
 // Kit artifact data only; real application acceptance is in reference-journey.
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-deploy-kit-')));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['dist/server','dist/client','migrations/core'])await mkdir(join(root,path),{recursive:true});
 await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
 await writeFile(join(root,'dist/server/index.js'),'export default {}');await writeFile(join(root,'dist/client/index.html'),'artifact bytes');
 await writeFile(join(root,'migrations/core/0001_owner.sql'),'CREATE TABLE owner(id TEXT PRIMARY KEY);');
 const declaration={version:1,project:'tests/fixture',compatibilityDate:'2026-09-08',d1:[{binding:'DB'}]};
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 const {account}=await import('./fixtures/owner-deploy.mjs');
 const {provider}=account(t);
 let builds=0;const store={report:()=>{}};
 // The caller's local operation: the build runs nested under it.
 const {localOperation}=await import('../onboarding/local/operation.mjs');const lock=await localOperation(root);t.after(()=>lock.release());
 const deploy=ownerDeploy('deploy.json',{run:async(...args)=>{builds++;assert.equal(args.at(-1).verb,'build');assert.equal(args.at(-1).operationToken,lock.token);}});
 const args={root,options:{dryRun:true},store,signal:new AbortController().signal,operationToken:lock.token};
 assert.deepEqual(await deploy(args),{dryRun:true,deployed:false});assert.equal(builds,1);assert.equal(provider.state.writes.length,0);
 assert.ok(provider.state.calls.length>0);assert.ok(provider.state.calls.every(call=>call.method==='GET'));
 const requests=provider.state.calls.length;
 await writeFile(join(root,'deploy.json'),JSON.stringify({...declaration,d1:[]}));
 await assert.rejects(deploy(args),/undeclared-migration-binding/);assert.equal(provider.state.calls.length,requests);
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
   assert.equal(failures,path.test('/workers/assets/upload') && kind.endsWith('transport') ? 2 : 1,'only content-addressed asset transport failures are replayed');
   assert.equal(provider.state.databases.length,1);
   assert.equal(provider.state.buckets.length,step==='create R2'?0:1);
   assert.equal(provider.state.settings,null,'the failed attempt did not publish a Worker');
  }finally{transport.mock.restore();provider.close();}
 }
});

test('site deploy preserves its redacted provider failure in human and JSON output', async t => {
 const {siteCommand} = await import('./site.mjs');
 const {siteProvider} = await import('../modules/deploy-kit/tests/site-provider.mjs');
 const {symlink} = await import('node:fs/promises');
 const {output} = await import('./output.mjs');
 const root = await realpath(await mkdtemp(join(tmpdir(),'rer-site-diagnostic-')));
 t.after(() => rm(root,{recursive:true,force:true}));
 await symlink(new URL('../default-seed/node_modules',import.meta.url).pathname,join(root,'node_modules'),'dir');
 await writeFile(join(root,'package.json'),'{}'); await writeFile(join(root,'site.mjs'),'export default {}');
 await writeFile(join(root,'deploy.json'),JSON.stringify({version:1,project:['synthetic-base-1','synthetic-base-2'].join('/'),compatibilityDate:'2026-09-08'}));
 await writeFile(join(root,'deploy-site.json'),JSON.stringify({version:1,domain:'synthetic-base-3.test'}));
 const provider = siteProvider({domain:'synthetic-base-3.test'}); t.after(() => provider.close());
 const names = ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN'], prior = names.map(name => process.env[name]);
 t.after(() => names.forEach((name,i) => {if(prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i];}));
 names.forEach((name,i) => {process.env[name] = i ? provider.token : provider.accountId;});
 t.mock.method(globalThis,'fetch',async (url,init) => new URL(url).pathname.endsWith('/assets-upload-session')
  ? new Response(`synthetic-base-4 ${provider.token} ${provider.accountId} https://synthetic-base-5.test/?signature=synthetic-base-6`,{status:403}) : provider.fetch(url,init));
 const store = {report:() => {},run:async (label,command,args) => {
  await writeFile(join(args[3],'index.html'),'<!doctype html><h1>Example</h1>');
  await writeFile(join(args[3],'run.html'),'<!doctype html><h1>Run</h1>');
 }};
 let caught;
 await assert.rejects(siteCommand({root,adapter:{site:{entry:'site.mjs',output:['dist','site'].join('/'),declaration:'deploy-site.json'}}},{verb:'deploy',json:true},store,undefined,{human:() => {}}),error => {caught = error;return true;});
 assert.equal(caught.code,'deploy_refused'); assert.match(caught.message,/creating site assets upload session/);
 assert.match(caught.message,/POST \/client\/v4\/accounts\/\[REDACTED\].*HTTP 403/);
 assert.equal(caught.siteDeploy.providerRequest.status,403);
 for (const json of [false,true]) {
  let written = '';
  const stdout = t.mock.method(process.stdout,'write',text => {written += text;return true;});
  const stderr = t.mock.method(process.stderr,'write',text => {written += text;return true;});
  try {output({verb:'deploy',json}).error(caught);} finally {stdout.mock.restore();stderr.mock.restore();}
  assert.ok(written.includes('synthetic-base-4'));
  for (const secret of [provider.accountId,provider.token,'signature=synthetic-base-6']) assert.ok(!written.includes(secret));
  if (json) assert.deepEqual(JSON.parse(written).siteDeploy,caught.siteDeploy); else assert.equal(written,caught.message+'\n');
 }
});
