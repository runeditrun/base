import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, link, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deployDiagnostic, providerRefusal } from '../diagnostics.mjs';
import { cloudflare } from '../provider.mjs';
import { regularBytes, readArtifact, collectFiles } from '../artifact.mjs';
import { assertCredentialFree } from '../prepare.mjs';
import { hash } from '../validation.mjs';
import { createTemplates, lockTemplates } from '../templates.mjs';
import { inspectOperations } from '../../../operations/operations.mjs';
const accountId='a'.repeat(32);
const response=(result,result_info)=>Response.json({success:true,result,errors:[],result_info});
async function temporary(t) {const dir=await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('transport uses exact account, rejects arbitrary URLs, redacts provider errors, and never retries an HTTP refusal',async()=>{
  let calls=0;const api=cloudflare({accountId,token:'test-secret',fetch:async(url,init)=>{calls++;assert.equal(new URL(url).pathname,`/client/v4/accounts/${accountId}/queues`);assert.equal(init.redirect,'error');return Response.json({error:'test-secret'},{status:403});}});
  await assert.rejects(api.request('https://evil.test'),/invalid-provider-path/);assert.equal(calls,0);
  await assert.rejects(api.request('/queues'),error=>error.message==='provider-http-403');assert.equal(calls,1);
});
test('provider read retries share the original timeout, cancellation and request budget', async () => {
  const pending = signal => new Promise((resolve,reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort',() => reject(signal.reason),{once:true});
  });
  // AbortSignal.timeout uses unref timers; this bounds and keeps this one request alive.
  const hold = setTimeout(() => {},1000);
  try {
    let calls = 0;
    const recovering = cloudflare({accountId,token:'test-secret',timeoutMs:80,fetch:async (url,{signal}) => {
      calls++;
      if (calls === 1) await pending(signal);
      return response([]);
    }});
    assert.deepEqual(await recovering.request('/queues'),[]);
    assert.equal(calls,2,'a timed-out first read leaves time for one retry');
    calls = 0;
    const timed = cloudflare({accountId,token:'test-secret',timeoutMs:80,fetch:async (url,{signal}) => {calls++;await pending(signal);}});
    await assert.rejects(timed.request('/queues'),error => error.message === 'provider-transport-failed' && error.providerTransport.attempts === 2 && error.providerTransport.reason === 'TimeoutError');
    assert.equal(calls,2,'the second read ends at the original request deadline');
    const controller = new AbortController(); calls = 0;
    const cancelled = cloudflare({accountId,token:'test-secret',fetch:async (url,{signal}) => {calls++;controller.abort();await pending(signal);}});
    await assert.rejects(cancelled.request('/queues',{signal:controller.signal}),/provider-transport-failed/);
    assert.equal(calls,1,'caller cancellation never starts another request');
    calls = 0;
    const limited = cloudflare({accountId,token:'test-secret',maxRequests:1,fetch:async () => {calls++;throw Object.assign(new Error('reset'),{code:'ECONNRESET'});}});
    await assert.rejects(limited.request('/queues'),/provider-transport-failed/);
    assert.equal(calls,1,'a retry cannot spend beyond the provider request budget');
    calls = 0;
    const shared = cloudflare({accountId,token:'test-secret',maxRequests:2,fetch:async () => {if (++calls === 1) throw Object.assign(new Error('reset'),{code:'ECONNRESET'});return response([]);}});
    assert.deepEqual(await shared.request('/queues'),[]);
    await assert.rejects(shared.request('/queues'),/provider-request-budget/);
  } finally { clearTimeout(hold); }
});
test('an expired deployment deadline is visible to provider retries before the next clock tick', async () => {
  const controller = new AbortController();
  let calls = 0, deadlines = 0;
  const api = cloudflare({accountId,token:'test-secret',
    requestSignal:() => { deadlines++; return controller.signal; },
    fetch:async (url,{signal}) => {
      calls++;
      controller.abort(new DOMException('Deployment deadline expired','TimeoutError'));
      signal.throwIfAborted();
      return response([]);
    }});
  await assert.rejects(api.request('/queues'),error => error.message === 'provider-transport-failed' && error.providerTransport.attempts === 1);
  assert.equal(calls,1,'an expired provider read is not retried');
  assert.equal(deadlines,1,'the operation captures its deadline once');
});
test('complete multi-page listing, partial page failure and request limits',async()=>{
  let calls=0;const api=cloudflare({accountId,token:'test',fetch:async()=>{calls++;return response([{name:`resource-${calls}`}],{page:calls,total_pages:2,total_count:2});}});
  assert.equal((await api.list('/d1/database')).length,2);
  const partial=cloudflare({accountId,token:'test',fetch:async()=>response([],{page:1,total_pages:1,total_count:2})});await assert.rejects(partial.list('/queues'),/partial-list/);
  const missing=cloudflare({accountId,token:'test',fetch:async()=>response([])});assert.deepEqual(await missing.list('/queues'),[]);
  const bounded=cloudflare({accountId,token:'test',maxRequests:1,fetch:async()=>response({})});await bounded.request('/workers/subdomain');await assert.rejects(bounded.request('/workers/subdomain'),/budget/);
});
test('R2 cursor traversal uses encoded cursors, rejects cycles and missing completion evidence',async()=>{
  let calls=0;const api=cloudflare({accountId,token:'test',fetch:async(url)=>{calls++;if(calls===1)return response({buckets:[{name:'one'}]},{per_page:1,cursor:'YWJj=='});assert(url.endsWith('cursor=YWJj%3D%3D'));return response({buckets:[]},{per_page:1});}});
  assert.equal((await api.list('/r2/buckets',{field:'buckets',pagination:'cursor'})).length,1);
  const cyclic=cloudflare({accountId,token:'test',fetch:async()=>response({buckets:[]},{per_page:100,cursor:'same'})});await assert.rejects(cyclic.list('/r2/buckets',{field:'buckets',pagination:'cursor'}),/cursor/);
});
test('body size, malformed success and malformed JSON fail closed',async()=>{
  for(const fetch of [async()=>Response.json({success:false,result:[]}),async()=>new Response('{'),async()=>new Response(' '.repeat(4*1024*1024+1))]) {const api=cloudflare({accountId,token:'test',fetch});await assert.rejects(api.request('/queues'));}
});
test('artifact rejects symlink, hardlink, directory, symlink parent and custody/hash mismatch',async t=>{
  const dir=await temporary(t);const file=join(dir,'data.json');await writeFile(file,'{}');await symlink(file,join(dir,'alias'));await assert.rejects(regularBytes(join(dir,'alias')));await link(file,join(dir,'hard'));await assert.rejects(regularBytes(file));await assert.rejects(regularBytes(dir));
  await mkdir(join(dir,'real'));await writeFile(join(dir,'real','file'),'data');await symlink(join(dir,'real'),join(dir,'fake'));await assert.rejects(regularBytes(join(dir,'fake','file')));
  const data={version:1,source:{sha:'1'.repeat(40),tree:'2'.repeat(40)},run:{id:'1',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:'',sha256:hash('')}],assets:[],migrations:[]};const path=join(dir,'artifact.json');const bytes=JSON.stringify(data);await writeFile(path,bytes);const expected={sha256:hash(bytes),sourceSha:data.source.sha,runId:'1',runAttempt:'1'};
  assert.equal((await readArtifact(path,expected)).main,'index.js');await assert.rejects(readArtifact(path,{...expected,runAttempt:'2'}),/custody/);await assert.rejects(readArtifact(path,{...expected,sha256:'0'.repeat(64)}),/digest/);
});
test('prepare refuses provider/mail/evidence credentials and Node injection before project execution',()=>{
  for(const name of ['CF_THROWAWAY_API_TOKEN','RESEND_API_KEY','SENDGRID_API_KEY','EVIDENCE_WRITE_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','NODE_OPTIONS','NODE_PATH']) assert.throws(()=>assertCredentialFree({[name]:'value'}));
  assert.doesNotThrow(()=>assertCredentialFree({PATH:'/usr/bin',CI:'true'}));
});
test('operations v2 required mail fails with missing, blank or wrong selected key; optional loops remain optional',async t=>{
  const dir=await temporary(t);await writeFile(join(dir,'verify.mjs'),'');
  const descriptor={version:2,project:'example/edition',runtime:{requirements:[]},requiredEnvironment:[],commands:{verify:{argv:['node','verify.mjs'],inputs:['verify.mjs'],effects:'Local validation'}},loops:[{id:'ticket-replies',type:'mail',required:true,enabled:true,provider:'resend'}]};
  await writeFile(join(dir,'OPERATIONS.json'),JSON.stringify(descriptor));
  for(const env of [{},{RESEND_API_KEY:' '},{SENDGRID_API_KEY:'fixture'},{RESEND_API_KEY:'fixture',MAIL_PROVIDER:'sendgrid'}]){const result=await inspectOperations(dir,env);assert.equal(result.ok,false);assert(!JSON.stringify(result).includes('fixture'));}
  assert.equal((await inspectOperations(dir,{RESEND_API_KEY:'fixture'})).ok,true);
  descriptor.loops[0].enabled=false;descriptor.loops[0].required=false;await writeFile(join(dir,'OPERATIONS.json'),JSON.stringify(descriptor));assert.equal((await inspectOperations(dir,{})).ok,true);
  descriptor.loops[0].required=true;await writeFile(join(dir,'OPERATIONS.json'),JSON.stringify(descriptor));assert.equal((await inspectOperations(dir,{RESEND_API_KEY:'fixture'})).ok,false);
});
test('new template calls real authoring lock/check and refuses any existing destination/lock',async t=>{
  const dir=await temporary(t);const root=join(dir,'edition');const args={destination:root,project:'example/edition',sourcePaths:['app.mjs'],commands:{verify:{argv:['node','app.mjs'],inputs:['app.mjs'],effects:'Local app validation'}}};
  const created=await createTemplates(args);await writeFile(join(root,'app.mjs'),'export const value=1;');const git=(...argv)=>execFileSync('git',argv,{cwd:root,stdio:'pipe'});git('init');git('add','.');
  await lockTemplates(root);const lock=JSON.parse(await readFile(join(root,'sources.lock.json'),'utf8'));assert(lock.toolchain?.sha256 ?? lock.tools?.sha256 ?? JSON.stringify(lock).includes(hash('export const value=1;')));
  execFileSync(process.execPath,created.check.slice(1),{cwd:root,stdio:'pipe'});
  assert.equal((await inspectOperations(root,{})).ok,true);await assert.rejects(createTemplates(args));await assert.rejects(lockTemplates(root),/existing-source-lock/);
});
test('D1 documented pagination without total_pages follows total_count and rejects unstable counts',async()=>{
  let page=0;const api=cloudflare({accountId,token:'test',fetch:async()=>{page++;return response([{name:`db-${page}`}],{page,per_page:1,total_count:2});}});assert.equal((await api.list('/d1/database')).length,2);
  page=0;const unstable=cloudflare({accountId,token:'test',fetch:async()=>{page++;return response([{name:`db-${page}`}],{page,per_page:1,total_count:page+1});}});await assert.rejects(unstable.list('/d1/database'),/pagination-changed/);
});
test('CLI missing inputs exits nonzero with names only',()=>{
  let output='';try{execFileSync(process.execPath,['modules/deploy-kit/cli.mjs','deploy'],{cwd:process.cwd(),env:{PATH:process.env.PATH},stdio:'pipe'});assert.fail('unexpected success');}catch(error){assert.equal(error.status,1);output=error.stderr.toString();}
  const result=JSON.parse(output);assert.equal(result.code,'missing-input');assert(result.inputs.includes('CF_THROWAWAY_API_TOKEN'));assert(result.inputs.includes('RER_DEPLOY_SOURCE_SHA'));
});
test('actual packer reads Vite-shaped regular output and binds file hashes; escaping main is refused',async t=>{
  const {packageBuild}=await import('../prepare.mjs');const dir=await temporary(t);const root=join(dir,'source');
  for(const path of ['default-seed/dist/server/assets','default-seed/dist/server/.vite','default-seed/dist/client','default-seed/migrations/core'])await mkdir(join(root,path),{recursive:true});
  await writeFile(join(root,'default-seed/dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));await writeFile(join(root,'default-seed/dist/server/index.js'),'export default {};');await writeFile(join(root,'default-seed/dist/server/assets/chunk.js'),'export const value=1;');await writeFile(join(root,'default-seed/dist/client/index.html'),'<h1>fixture</h1>');await writeFile(join(root,'default-seed/migrations/core/0001_schema.sql'),'CREATE TABLE example(id TEXT);');
  await writeFile(join(root,'default-seed/dist/server/.vite/manifest.json'),JSON.stringify({'virtual:cloudflare/worker-entry':{file:'index.js',isEntry:true}}));
  const args={root,source:{sha:'1'.repeat(40),tree:'2'.repeat(40)},runIdentity:{id:'1',attempt:'1'}};const artifact=await packageBuild(args);assert.equal(artifact.modules.length,2);assert.equal(artifact.assets.length,1);assert.equal(artifact.migrations[0].sha256,hash('CREATE TABLE example(id TEXT);'));
  await writeFile(join(root,'default-seed/dist/server/wrangler.json'),JSON.stringify({main:'../../outside.js'}));await assert.rejects(packageBuild(args),/local-path/);
});

test('D1 file import confines signed uploads, verifies bytes and polls without forwarding account credentials', async () => {
  const {createHash}=await import('node:crypto');
  const id='12345678-1234-1234-1234-123456789abc', sql="CREATE TRIGGER audit AFTER INSERT ON source BEGIN SELECT 1; SELECT 2; END;";
  const etag=createHash('md5').update(sql).digest('hex');
  const uploadURL=`https://${'b'.repeat(32)}.r2.cloudflarestorage.com/import.sql?signature=test-signed-secret`;
  // The REST schema has envelope errors only; Wrangler also accepts nested errors.
  for(const nestedErrors of [{},{errors:[]}]){
    const actions=[];
    const api=cloudflare({accountId,token:'test-account-secret',fetch:async(url,init)=>{
      assert.equal(init.redirect,'error');
      if(url===uploadURL){assert.deepEqual(Object.keys(init.headers),['Content-Length']);assert.equal(Buffer.from(init.body).toString(),sql);assert.equal(Number(init.headers['Content-Length']),Buffer.byteLength(sql));return new Response(null,{headers:{etag:`"${etag}"`}});}
      assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${id}/import`);
      assert.equal(init.headers.Authorization,'Bearer test-account-secret');const body=JSON.parse(init.body);actions.push(body.action);
      if(body.action==='init'){assert.equal(body.etag,etag);return response({upload_url:uploadURL,filename:'import.sql'});}
      if(body.action==='ingest'){assert.deepEqual(body,{action:'ingest',filename:'import.sql',etag});return response({success:true,type:'import',status:'active',at_bookmark:'bookmark',...nestedErrors});}
      assert.deepEqual(body,{action:'poll',current_bookmark:'bookmark'});return response({success:true,type:'import',status:'complete',...nestedErrors,result:{num_queries:1,final_bookmark:'finished'}});
    }});
    await api.importSql(id,sql);assert.deepEqual(actions,['init','ingest','poll']);
  }
  for(const url of ['http://127.0.0.1/file?sig=x',`https://${accountId}.r2.cloudflarestorage.com.evil.test/file?sig=x`,`https://u:p@${accountId}.r2.cloudflarestorage.com/file?sig=x`,`https://${accountId}.r2.cloudflarestorage.com:8443/file?sig=x`,`https://${accountId}.r2.cloudflarestorage.com/file?sig=x#secret`]){
    let calls=0;const rejected=cloudflare({accountId,token:'test',fetch:async()=>{calls++;return response({upload_url:url,filename:'import.sql'});}});
    await assert.rejects(rejected.importSql(id,sql),/invalid-d1-import-upload-url/);assert.equal(calls,1);
  }
});

test('D1 import failures keep Cloudflare\'s reason without upload secrets or credentials and never retry uncertain ingestion', async () => {
  const id='12345678-1234-1234-1234-123456789abc';
  for(const mode of ['etag','redirect','transport','poll','envelope','limit','cached']){
    let calls=0;
    const api=cloudflare({accountId,token:'test-token',maxRequests:5,fetch:async(url,init)=>{
      calls++;
      const result={success:true,type:'import',status:'active',at_bookmark:'bookmark',errors:[]};
      if(calls===1){if(mode==='cached')return response({...result,status:'complete',result:{num_queries:1,final_bookmark:'done'}});if(['poll','envelope','limit'].includes(mode))return response(result);return response({filename:'sql',upload_url:`https://${accountId}.r2.cloudflarestorage.com/sql?sig=secret-upload`});}
      if(mode==='transport')throw Error('secret-upload');
      if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.test'}});
      if(mode==='etag')return new Response(null,{headers:{etag:'wrong'}});
      if(mode==='envelope')return Response.json({success:false,errors:[{code:7500,message:`no such table: lookup; upload https://${accountId}.r2.cloudflarestorage.com/sql?sig=secret-upload with test-token`}]},{status:400});
      if(mode==='poll')return response({...result,status:'error',errors:[`no such table: lookup; upload https://${accountId}.r2.cloudflarestorage.com/sql?sig=secret-upload with test-token`]});
      return response(result);
    }});
    if(mode==='cached'){await api.importSql(id,'SELECT 1;');assert.equal(calls,1);continue;}
    await assert.rejects(api.importSql(id,'SELECT 1;'),error=>{
      const kept=JSON.stringify([deployDiagnostic(error,String),error.providerRefusal,error.message]);
      for(const secret of ['secret-upload','test-token',accountId])assert(!kept.includes(secret));
      if(['envelope','poll'].includes(mode))assert.match(providerRefusal(error),/no such table: lookup; upload \[URL omitted\] with \[REDACTED\]/);
      return /d1-import|provider-http|budget/.test(error.message);});
    assert.equal(calls,mode==='limit'?5:2);
  }
  const complete={success:true,type:'import',status:'complete',result:{num_queries:1,final_bookmark:'finished'}};
  const malformed=[
    ...[null,{},'',false,0,['private SQL']].map(errors=>({...complete,errors})),
    {...complete,success:false}, {...complete,type:'export'}, {...complete,status:'error'},
    {...complete,result:null}, {...complete,result:{num_queries:0,final_bookmark:'finished'}},
    {...complete,result:{num_queries:1,final_bookmark:''}},
    ...[undefined,null,'',42].map(at_bookmark=>({success:true,type:'import',status:'active',at_bookmark})),
    null, [], 'private SQL',
  ];
  for(const result of malformed){
    const actions=[];
    const api=cloudflare({accountId,token:'test-token',fetch:async(url,init)=>{
      const body=JSON.parse(init.body);actions.push(body.action);
      return response(actions.length===1 ? {success:true,type:'import',status:'active',at_bookmark:'bookmark'} : result);
    }});
    await assert.rejects(api.importSql(id,'SELECT 1;'),/^Error: d1-import-(failed|invalid-result|uncertain)$/);
    assert.deepEqual(actions,['init','poll']);
  }
});
