import { DurableObject } from 'cloudflare:workers';
import { claimKeys, signClaim } from '../claim.mjs';
import { seal, random } from './session.mjs';
import { provider, visitorName, upload, visitorFetch, destroy } from './resources.mjs';

const IDLE = 15 * 60_000;
export class NativeVisitor extends DurableObject {
 async begin(options) {
  if (!await this.ctx.storage.get('state')) {
   const state = {id:this.ctx.id.toString(), ends:options.ends, seen:Date.now(), phase:'starting', secret:random(), d1:[],r2:[],timings:{},started:Date.now()};
   state.name = visitorName(this.env,state.id,state.ends);
   await this.ctx.storage.put('state',state);
   await this.ctx.storage.setAlarm(Math.min(state.ends, Date.now()+120_000));
   this.starting=this.start(state,options);
   this.ctx.waitUntil(this.starting.catch(async error=>{
    // Provider diagnostics contain operation/code, never uploaded secrets or bodies.
    console.error(JSON.stringify({event:'native_start_failed', name:state.name, code:error.message, provider:error.providerRefusal,transport:error.providerTransport}));
    await this.ctx.storage.put('failure',{phase:'failed',timings:state.timings,code:error.message,provider:error.providerRefusal,transport:error.providerTransport});
    await this.end();
   }));
  }
  return this.status();
 }
 async status(wait = 0) {
  const until = Date.now()+Math.min(wait,1500);
  let state;
  do {
   state = await this.ctx.storage.get('state');
   if (state?.phase !== 'starting' || Date.now() >= until) break;
   await new Promise(resolve=>setTimeout(resolve,50));
  } while (true);
  if (!state) return await this.ctx.storage.get('failure') ?? {phase:'failed'};
  return {phase:state.phase,...(state.phase==='ready'?{cookies:state.cookies,location:state.location}:{}),timings:state.timings};
 }
 async start(state, options) {
  const api = provider(this.env);
  const save = () => this.ctx.storage.put('state',state);
  const timed = async (name, action) => {
   const at = Date.now(); const result = await action(); state.timings[name] = Date.now()-at;
   await save(); return result;
  };
  const bundle = await timed('bundle', async()=>{
   const response = await this.env.ASSETS.fetch('https://bundle.invalid/__rer_native/bundle.json');
   if (!response.ok) throw new Error('native-bundle-missing');
   return response.json();
  });
  for (const db of bundle.d1) await timed(`d1_create_${db.binding}`,async()=>{
   const row = await api.request('/d1/database',{method:'POST',body:{name:state.name+'-'+db.binding.toLowerCase(),primary_location_hint:'oc'}});
   state.d1.push({binding:db.binding,id:row.uuid}); await save();
  });
  for (const bucket of bundle.r2) await timed(`r2_create_${bucket.binding}`,async()=>{
   const name=state.name+'-'+bucket.binding.toLowerCase();
   await api.request('/r2/buckets',{method:'POST',body:{name,locationHint:'oc'}});
   state.r2.push({binding:bucket.binding,name}); await save();
  });
  await timed('migrations',async()=>{
   for (const db of state.d1) {
    const sql=bundle.migrations[db.binding];
    if (sql) await api.request(`/d1/database/${db.id}/query`,{method:'POST',body:{sql}});
   }
  });
  const keys = await claimKeys();
  const origin=options.origin, owner=this.env.DEMO_OWNER_EMAIL || 'owner@demo.invalid';
  await timed('upload',()=>upload(this.env,bundle,state,{
   ...options.settings,RER_DEMO:'1',[options.originVar]:origin,RER_NATIVE_ORIGIN:origin,RER_NATIVE_ENDS:String(state.ends),
   SESSION_SECRET:random(),SETUP_TOKEN:random(),OWNER_EMAIL:owner,
   RER_OWNER_CLAIM_ISSUER:origin,RER_OWNER_CLAIM_INSTALLATION_ID:state.id,RER_OWNER_CLAIM_APP_ORIGIN:origin,
   RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify(keys.publicKeys),RER_DEMO_EXPIRES:options.endsLocal,
  }));
  await timed('first_request',async()=>{
   const deadline=Date.now()+15000;
   for (;;) {
    const response=await visitorFetch(this.env,state,'/health');
    const detail=await response.text();
    if (response.ok) return;
    // workers.dev routing briefly returns 404 while an uploaded script propagates.
    if (response.status!==404||Date.now()>=deadline) throw new Error(`native-first-request-${response.status}: ${detail.slice(0,240)}`);
    await new Promise(resolve=>setTimeout(resolve,100));
   }
  });
  const claimed=await timed('owner_claim',async()=>{
   const token=await signClaim(keys,{origin,installationId:state.id,email:owner,now:Date.now()});
   const response=await visitorFetch(this.env,state,'/auth/owner-claim',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
   if (response.status!==303) { await response.body?.cancel(); throw new Error(`native-owner-claim-${response.status}`); }
   await response.body?.cancel(); return response;
  });
  const cookies = claimed.headers.getSetCookie();
  await timed('seed',async()=>{
   const response=await visitorFetch(this.env,state,'/health',{headers:{cookie:cookies.map(c=>c.split(';')[0]).join('; ')}});
   if (!response.ok) { await response.body?.cancel(); throw new Error(`native-seed-${response.status}`); }
   await response.arrayBuffer();
  });
  if (Date.now() >= state.ends) throw new Error('native-expired-during-start');
  state.timings.total=Date.now()-state.started;
  const route=await seal({id:state.id,name:state.name,secret:state.secret,ends:state.ends},this.env.DEMO_COOKIE_SECRET);
  state.phase='ready';state.cookies=cookies;state.location=claimed.headers.get('location') || '/';state.seen=Date.now();
  state.route=route;state.crons=bundle.crons;
  await save();
  await this.ctx.storage.setAlarm(Math.min(state.ends,state.seen+IDLE));
  await this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')).extend(state.id,state.ends);
  await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('visitors')).add(state.id,state.ends);
  console.log(JSON.stringify({event:'native_start_ready',name:state.name,timings:state.timings}));
 }
 async route() { return (await this.ctx.storage.get('state'))?.route; }
 async touch() {
  const state=await this.ctx.storage.get('state');
  if (!state || state.phase!=='ready') return false;
  if (Date.now()>=Math.min(state.ends,state.seen+IDLE)) { await this.end();return false; }
  state.seen=Date.now();await this.ctx.storage.put('state',state);
  await this.ctx.storage.setAlarm(Math.min(state.ends,state.seen+IDLE));return true;
 }
 async tick(cron, at) {
  const state=await this.ctx.storage.get('state');
  if (!state || state.phase!=='ready') return;
  if (at>=Math.min(state.ends,state.seen+IDLE)) return this.end();
  if (!(state.crons??[]).includes(cron)) return;
  const response=await visitorFetch(this.env,state,'/__rer_native/scheduled',{method:'POST',body:cron});
  await response.body?.cancel();
  if (!response.ok) throw new Error(`native-scheduled-${response.status}`);
 }
 async diagnostic() {
  const state=await this.ctx.storage.get('state');
  return state?{phase:state.phase,name:state.name,d1:state.d1,r2:state.r2,ends:state.ends,seen:state.seen,timings:state.timings,failure:await this.ctx.storage.get('failure')}:await this.ctx.storage.get('failure')??null;
 }
 async alarm() {
  const state=await this.ctx.storage.get('state');
  if (!state) return this.ctx.storage.deleteAll();
  if (state.phase!=='ready'||Date.now()>=Math.min(state.ends,state.seen+IDLE)) return this.end();
  await this.ctx.storage.setAlarm(Math.min(state.ends,state.seen+IDLE));
 }
 async end() {
  // Serialize against start: expiry/cancel cannot delete while API writes are in flight.
  if (this.ending) return this.ending;
  this.ending=(async()=>{ await this.starting?.catch(()=>{}); return this.cleanup(); })();try {return await this.ending;} finally {this.ending=null;}
 }
 async cleanup() {
  const state=await this.ctx.storage.get('state');
  if (!state) return;
  state.phase='ending';await this.ctx.storage.put('state',state);await this.ctx.storage.setAlarm(Date.now()+30_000);
  await destroy(this.env,state);
  await this.env.CAPACITY.get(this.env.CAPACITY.idFromName('capacity')).release(state.id);
  await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('visitors')).drop(state.id);
  await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();
 }
}
