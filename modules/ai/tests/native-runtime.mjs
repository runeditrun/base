import { build } from '../../../default-seed/node_modules/esbuild/lib/main.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
const text = '@cf/qwen/qwen3.8-27b', image = '@cf/black-forest-labs/flux-2-dev';
export const declaration = {schema:1,provider:'cloudflare',transport:'native',binding:'AI',budgetBinding:'AI_BUDGET',imageBinding:'AI_IMAGES',textModels:[text],imageModels:[image],purposes:[{id:'site-read',kind:'text',model:text},{id:'house-style',kind:'image',model:image}],limits:{calls:100,units:100000000,microUsd:100000000},operations:{textCalls:2,maxInputBytes:10000,maxOutputTokens:1024,imageUnits:100,timeoutMs:1000}};
export const authority = {schema:1,enabled:true,installation:'synthetic-installation',environment:'test',tenant:'synthetic-tenant',revision:'initial',custody:'original',permitted:declaration,
  prices:Object.fromEntries([text,image].map(m => [m,{version:'synthetic-prices',validUntil:Date.now()+86400000,inputMicroUsdPerMillion:450000,outputMicroUsdPerMillion:3200000,imageMicroUsdPerUnit:4100000}])),
  proofs:{[text]:{reference:'synthetic-text-edge',kind:'text',maxInputTokens:262144,maxOutputTokens:1024,maxImageUnits:0,mime:''},[image]:{reference:'synthetic-image-edge',kind:'image',maxInputTokens:0,maxOutputTokens:0,maxImageUnits:100,mime:'image/png'}}};
const built = await build({entryPoints:[new URL('./native-worker.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const schema = await readFile(new URL('../../operator-auth/accounts/schema/operator-auth.sql',import.meta.url),'utf8');
export function samplePng() {
 const crc = bytes => {let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
 const chunk=(name,bytes)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,25,50,75,255]))),chunk('IEND',Buffer.alloc(0))]);
}
export async function nativeRuntime(t,{request=declaration,policy=authority,provider,bindings={}}={}) {
 const folder=await mkdtemp(join(tmpdir(),'rer-ai-native-'));
 const hits=[];let publicBucket=false;
 const env={AUTH_ORIGIN:bindings.AUTH_LOCAL === 'true' ? 'http://127.0.0.1:8787' : 'https://reference.test',OWNER_EMAIL:'owner@example.test',SESSION_SECRET:'synthetic-session-secret-for-native-ai-tests-0001',SETUP_TOKEN:'synthetic-setup-token-for-native-ai-tests-0001',INSTALLATION_KEY:'a'.repeat(64),RER_AI_REQUEST:JSON.stringify(request),RER_AI_AUTHORITY:JSON.stringify(policy),RER_AI_ACCOUNT_ID:'a'.repeat(32),RER_AI_BUCKET_NAME:'synthetic-ai-images',RER_AI_PRIVACY_TOKEN:'synthetic-privacy-token',...bindings};
 const init=()=>new Miniflare({...convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-09-08',bindings:env,d1Databases:{DB:'ai-auth'},r2Buckets:{AI_IMAGES:'ai-images'},durableObjects:{AI_BUDGET:{className:'AiAuthority',useSQLite:true}},outboundService:async request=>{
  if(request.url.startsWith('https://api.cloudflare.com/'))return Response.json({success:true,result:request.url.endsWith('/managed')?{enabled:publicBucket}:{domains:[]}});
  if(request.url==='https://provider.test/infer'){
   const body=await request.json();hits.push(body);
   if(provider)return provider(body,hits.length);
   if(body.input==='image')return Response.json({image:samplePng().toString('base64')});
   return Response.json({choices:[{message:{role:'assistant',content:'Synthetic summary'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8}});
  }
  throw Error('Unexpected external request');
 }}),resourcePersistencePath:join(folder,'state')});
 let mf=init();
 t.after(async()=>{await mf.dispose();await rm(folder,{recursive:true,force:true});});
 const db=await mf.getD1Database('DB');
 for(const sql of schema.replace(/^--.*$/gm,'').match(/CREATE TRIGGER[\s\S]*?END;|CREATE (?:TABLE|INDEX)[\s\S]*?;/g))await db.prepare(sql).run();
 const call=async(path,{body,cookie,origin=env.AUTH_ORIGIN,method=body===undefined?'GET':'POST',headers={}}={})=>mf.dispatchFetch('http://localhost/',{method:'POST',body:JSON.stringify({url:env.AUTH_ORIGIN+path,method,headers:{host:new URL(env.AUTH_ORIGIN).host,origin,...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})});
 const bootstrap=await call('/auth/bootstrap',{body:{token:env.SETUP_TOKEN,displayName:'Synthetic Owner'}});
 if(bootstrap.status!==303)throw Error(`Bootstrap failed ${bootstrap.status}: ${await bootstrap.text()}`);
 const cookie=bootstrap.headers.get('set-cookie').split(';')[0];
 return {call,cookie,hits,get db(){return mf.getD1Database('DB');},get bucket(){return mf.getR2Bucket('AI_IMAGES');},public(value){publicBucket=value;},async restart(change={}){await mf.dispose();Object.assign(env,change);mf=init();await mf.ready;},async status(){const r=await call('/api/ai',{cookie,body:{action:'status'}});return {status:r.status,...await r.json()};}};
}
