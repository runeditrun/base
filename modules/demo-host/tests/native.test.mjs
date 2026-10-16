import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// One public-door flow. Only Cloudflare's paid API and public network are faked;
// routing, owner-claim signing, encrypted cookies, DO lifecycle and teardown run in workerd.
test('native demo provisions isolated visitors, guards routing and deletes their resources',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url)),paths=[];
 for(const dir of ['modules/demo-host','modules/demo-host/native','modules/deploy-kit'])for(const name of await readdir(root+dir))if(name.endsWith('.mjs'))paths.push(dir+'/'+name);
 paths.push('cli/scheduled.mjs');
 const origin='https://demo.native.example',scripts=new Map(),databases=new Map();
 const envelope=result=>Response.json({success:true,errors:[],messages:[],result});
 const missing=()=>Response.json({success:false,errors:[]},{status:404});
 const bundle={main:'app.mjs',modules:[{path:'app.mjs',base64:Buffer.from('export default {}').toString('base64')}],d1:[{binding:'DB'}],r2:[],migrations:{DB:'CREATE TABLE example(id TEXT);'},vars:{},crons:[],compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat']};
 let sequence=0;
 const mf=new Miniflare(convertV4MiniflareOptions({
  modulesRoot:root,modules:[{type:'ESModule',path:root+'modules/demo-host/native/worker.mjs'},...paths.filter(p=>p!=='modules/demo-host/native/worker.mjs').map(path=>({type:'ESModule',path:root+path}))],
  compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
  durableObjects:{DEMO:{className:'NativeVisitor',useSQLite:true},CAPACITY:{className:'DemoCapacity',useSQLite:true},REGISTRY:{className:'NativeRegistry',useSQLite:true}},
  ratelimits:{STARTS:{namespace_id:'1002',simple:{limit:3,period:60}}},
  bindings:{DEMO_ORIGIN:origin,DEMO_SITE:'https://native.example',DEMO_NAME:'Test',DEMO_SETTINGS:'{}',DEMO_ORIGIN_VAR:'AUTH_ORIGIN',DEMO_MAX_INSTANCES:'2',DEMO_WORKER:'pf-native-test',DEMO_ACCOUNT_ID:'12345678901234567890123456789012',DEMO_API_TOKEN:'test-api-credential',DEMO_SUBDOMAIN:'native',DEMO_COOKIE_SECRET:'test-cookie-credential-with-enough-entropy',TURNSTILE_SECRET_KEY:'real-secret',TURNSTILE_SITE_KEY:'site-key',DEMO_TTL_MS:'60000'},
  serviceBindings:{ASSETS:request=>new URL(request.url).pathname==='/__rer_native/bundle.json'?Response.json(bundle):new Response('asset')},
  outboundService:async request=>{
   const url=new URL(request.url),path=url.pathname;
   if(url.hostname==='challenges.cloudflare.com')return Response.json({success:true});
   if(url.hostname==='api.cloudflare.com'){
    if(path.endsWith('/d1/database')&&request.method==='POST'){const id=`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;databases.set(id,await request.json());return envelope({uuid:id});}
    const db=/\/d1\/database\/([^/]+)(\/query)?$/.exec(path);
    if(db){if(!databases.has(db[1]))return missing();if(request.method==='DELETE'){databases.delete(db[1]);return envelope(null);}return envelope(db[2]?[{success:true,results:[]}]:databases.get(db[1]));}
    const script=/\/workers\/scripts\/([^/]+)(\/subdomain)?$/.exec(path);
    if(script){if(request.method==='PUT'){const form=await request.formData();scripts.set(script[1],JSON.parse(await form.get('metadata').text()));return envelope({});}if(script[2])return envelope({enabled:true});if(request.method==='DELETE'){scripts.delete(script[1]);return envelope(null);}return scripts.has(script[1])?envelope({}):missing();}
    throw new Error('Unexpected API operation: '+request.method+' '+path);
   }
   const name=url.hostname.split('.')[0],metadata=scripts.get(name);
   if(!metadata)return new Response(null,{status:404});
   const secret=metadata.bindings.find(b=>b.name==='RER_NATIVE_SECRET').text;
   if(request.headers.get('x-rer-native-secret')!==secret)return new Response(null,{status:404});
   if(path==='/auth/owner-claim')return new Response(null,{status:303,headers:{location:'/app','set-cookie':`__Host-session=${name}; Path=/; HttpOnly; Secure`}});
   if(path==='/health')return Response.json({ok:true});
   return Response.json({database:metadata.bindings.find(b=>b.type==='d1').id});
  },
 }));
 const call=(path,init={})=>mf.dispatchFetch(origin+path,{redirect:'manual',...init});
 const start=async()=>{
  let response=await call('/__demo/start',{method:'POST',headers:{origin,accept:'application/json'},body:new URLSearchParams({'cf-turnstile-response':'passed'})});
  let cookie;
  for(let n=0;n<30&&response.status===202;n++){
   cookie=response.headers.getSetCookie().find(x=>x.startsWith('rer_demo=')).split(';')[0];await response.body?.cancel();
   response=await call('/__demo/status',{headers:{cookie,accept:'application/json'}});
  }
  assert.equal(response.status,200,await response.clone().text());
  return response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 };
 try{
  assert.equal((await call('/')).status,200);
  const one=await start(),two=await start();assert.notEqual(one,two);
  const read=cookie=>call('/api/data',{headers:{cookie}}).then(r=>r.json());
  assert.notEqual((await read(one)).database,(await read(two)).database);
  assert.equal((await call('/api/data',{headers:{cookie:'rer_demo=forged'}})).status,410);
  for(const path of ['/__rer_native/bundle.json','/%5f%5frer_native/bundle.json'])assert.equal((await call(path)).status,404);
  const asset=await call('/assets/app-12345678.js');assert.equal(asset.headers.get('cache-control'),'public, max-age=31536000, immutable');
  assert.equal(scripts.size,2);assert.equal(databases.size,2);
  for(const cookie of [one,two])assert.equal((await call('/__demo/cancel',{method:'POST',headers:{origin,cookie}})).status,204);
  assert.equal(scripts.size,0);assert.equal(databases.size,0);
 }finally{await mf.dispose();}
});
