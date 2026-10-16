import { startPage, endedPage, demoCookie, clearCookie } from '../pages.mjs';
import { equalSecret } from '../operator.mjs';
import { measured, testHost } from '../measurement.mjs';
import { cookieValue, unseal } from './session.mjs';
import { visitorFetch } from './resources.mjs';
export { NativeVisitor } from './visitor.mjs';
export { NativeRegistry } from './registry.mjs';
export { DemoCapacity } from '../capacity.mjs';

const home=()=>new Response(null,{status:303,headers:{location:'/'}});
const json=request=>request.headers.get('accept')==='application/json';
function refuse(request,env,status,notice) {
 return json(request)?Response.json({notice},{status,headers:{'cache-control':'no-store'}}):startPage(env,{status,notice});
}
async function identity(request,env) {
 const value=cookieValue(request);
 if (!value) return null;
 const route=await unseal(value,env.DEMO_COOKIE_SECRET);
 if (route) return route;
 // A pending id has no routing authority; it is accepted only on progress/cancel.
 if (new URL(request.url).pathname.startsWith('/__demo/')&&/^[a-f0-9]{64}$/.test(value)) return {id:value};
 return null;
}
const stub=(env,id)=>env.DEMO.get(env.DEMO.idFromString(id));
async function progress(request,env,id,state) {
 if (state.phase==='failed'||state.phase==='ending') return refuse(request,env,502,'The demo did not start. Try again.');
 const headers=new Headers({'cache-control':'no-store'});
 headers.append('set-cookie',demoCookie(env,state.phase==='ready'?await stub(env,id).route():id));
 if (state.phase!=='ready') {
  headers.set('retry-after','1');
  return json(request)?Response.json({pending:true},{status:202,headers}):startPage(env,{status:202,pending:true,headers:Object.fromEntries(headers)});
 }
 for (const cookie of state.cookies) headers.append('set-cookie',cookie);
 headers.set('server-timing',Object.entries(state.timings).map(([key,ms])=>`${key};dur=${ms}`).join(', '));
 if (json(request)) return Response.json({location:state.location,timings:state.timings},{headers});
 headers.set('location',state.location);return new Response(null,{status:303,headers});
}
async function start(request,env) {
 if (request.headers.get('origin')!==env.DEMO_ORIGIN) return refuse(request,env,403,'Start the demo from this page.');
 if (testHost(env)&&!await measured(request,env)) return refuse(request,env,403,'This test host requires its measurement token.');
 const ip=request.headers.get('cf-connecting-ip')??'';
 if (!(await env.STARTS.limit({key:ip})).success) return refuse(request,env,429,'Too many demos started from your network. Try again in a minute.');
 const form=await request.formData(),token=form.get('cf-turnstile-response');
 if (typeof token!=='string'||token.length>2048) return refuse(request,env,403,'The check did not pass. Try again.');
 const verified=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:env.TURNSTILE_SECRET_KEY,response:token,remoteip:ip}),signal:AbortSignal.timeout(5000)});
 if (!verified.ok||!(await verified.json()).success) return refuse(request,env,403,'The check did not pass. Try again.');
 const prior=await identity(request,env);
 if (prior) {
  const state=await stub(env,prior.id).status();
  if (state.phase==='starting') return progress(request,env,prior.id,state);
 }
 const id=env.DEMO.newUniqueId(),ends=Date.now()+Number(env.DEMO_TTL_MS??3600000);
 if (!await env.CAPACITY.get(env.CAPACITY.idFromName('capacity')).acquire(id.toString(),Date.now()+120000,Number(env.DEMO_MAX_INSTANCES))) return refuse(request,env,503,'Every demo is in use right now. Try again in a few minutes.');
 const state=await env.DEMO.get(id).begin({origin:env.DEMO_ORIGIN,originVar:env.DEMO_ORIGIN_VAR,ends,endsLocal:new Date(ends).toISOString(),settings:JSON.parse(env.DEMO_SETTINGS)});
 return progress(request,env,id.toString(),state);
}
export default {
 async fetch(request,env,ctx) {
  const url=new URL(request.url);
  if (url.origin!==env.DEMO_ORIGIN) return new Response('Not found',{status:404});
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
  if (pathname.startsWith('/__rer_native/')) return new Response('Not found',{status:404});
  if (url.pathname.startsWith('/__demo/operator/')) {
   if (!await equalSecret(env.RER_DEMO_OPERATOR_TOKEN,request.headers.get('authorization')?.slice(7))) return new Response('Unauthorized',{status:401});
   const id=url.pathname.slice('/__demo/operator/'.length);
   if (id==='sweep'&&request.method==='POST') {await env.REGISTRY.get(env.REGISTRY.idFromName('visitors')).sweep();return Response.json({swept:true});}
   if (!/^[a-f0-9]{64}$/.test(id)) return new Response('Not found',{status:404});
   return Response.json(await stub(env,id).diagnostic());
  }
  if (url.pathname==='/__demo/start') return request.method==='POST'?start(request,env):home();
  const route=await identity(request,env);
  if (url.pathname==='/__demo/status') return route?progress(request,env,route.id,await stub(env,route.id).status(1500)):refuse(request,env,410,'This demo has ended. Start a new demo.');
  if (url.pathname==='/__demo/cancel') {
   if (request.method!=='POST'||request.headers.get('origin')!==env.DEMO_ORIGIN) return new Response(null,{status:403});
   if (route) await stub(env,route.id).end();
   return new Response(null,{status:204,headers:{'set-cookie':clearCookie(env)}});
  }
  // No per-visitor Worker (or DO) handles static files. Bundle storage is private.
  if (['GET','HEAD'].includes(request.method)&&/\.[a-zA-Z0-9]+$/.test(url.pathname)&&!url.pathname.endsWith('.html')) {
   const asset=await env.ASSETS.fetch(request);
   if (asset.status!==404) {
    const headers=new Headers(asset.headers);
    if (/\/assets\/.*-[a-zA-Z0-9_-]{8,}\./.test(url.pathname)) headers.set('cache-control','public, max-age=31536000, immutable');
    return new Response(asset.body,{status:asset.status,headers});
   }
  }
  if (route?.secret) {
   // Idle bookkeeping runs beside the request; the native Worker is the data path.
   ctx.waitUntil(stub(env,route.id).touch());
   const response=await visitorFetch(env,route,url.pathname+url.search,{method:request.method,headers:request.headers,body:request.body});
   if (response.status===404&&await stub(env,route.id).diagnostic()===null) return endedPage(env,{headers:{'set-cookie':clearCookie(env)}});
   return response;
  }
  if (cookieValue(request)) return endedPage(env,{headers:{'set-cookie':clearCookie(env)}});
  if (!['GET','HEAD'].includes(request.method)) return new Response('Start a demo first',{status:403});
  return url.pathname==='/'?startPage(env):home();
 },
 async scheduled(controller,env,ctx) {
  ctx.waitUntil(env.REGISTRY.get(env.REGISTRY.idFromName('visitors')).tick(controller.scheduledTime));
 },
};
