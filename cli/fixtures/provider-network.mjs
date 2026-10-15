import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
// Network-only replacement: both the real CLI and emitted Worker's outgoing
// provider requests reach a controlled local Auth server. Application code,
// local D1, lifecycle commands and authorization remain unchanged.
const original=globalThis.fetch;
const issuer='https://idp.example.test';
globalThis.fetch=async(input,init)=>{
 const request=input instanceof Request?new Request(input,init):input?.url?new Request(input.url,{method:input.method,headers:input.headers,...(!['GET','HEAD'].includes(input.method)?{body:await input.text()}:{}),...init}):new Request(input,init);
 if(new URL(request.url).origin===issuer) {
  const headers=new Headers(request.headers);for(const name of ['host','connection','content-length','transfer-encoding'])headers.delete(name);
  const response=await original(process.env.AUTH_TEST_EDGE+new URL(request.url).pathname,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:await request.text()}:{}),redirect:'manual'});
  return new Response(response.body,{status:response.status,headers:response.headers});
 }
 if(!['127.0.0.1','localhost','[::1]'].includes(new URL(request.url).hostname))throw Error('Unexpected test network destination');
 return original(request);
};
try {
 const require=createRequire(await realpath(resolve(process.cwd(),'node_modules/wrangler/package.json')));
 const path=require.resolve('miniflare'),mod=require(path),Real=mod.Miniflare;
 // Vite discovers Worker exports and calls setOptions during initial startup.
 // Keep the controlled network edge across that update as well as construction.
 const controlled = options => ({...options,workers:options.workers?.map(worker=>({...worker,dev:{...worker.dev,outboundService:{type:'fetcher',handler:async request=>{const r=await globalThis.fetch(request);return Response.json(await r.json(),{status:r.status});}}}}))});
 class ProviderRuntime extends Real {
  constructor(options){super(controlled(options));}
  setOptions(options){return super.setOptions(controlled(options));}
 }
 require.cache[path].exports=new Proxy(mod,{get(target,key){return key==='Miniflare'?ProviderRuntime:Reflect.get(target,key);}});
} catch(error) { if(error.code!=='MODULE_NOT_FOUND')throw error; }
