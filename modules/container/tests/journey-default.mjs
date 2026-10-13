import {assert,json,bootstrapAndOutbox,wait,control,performance,summary} from './common.mjs';
export async function defaultJourney(client,settings,name){
 const denied=await client.call('/api/work');if(denied.status!==401)throw Error('Signed-out admission: '+denied.status+' '+await denied.text());assert.equal(denied.status,401,'private API rejects signed-out request');
 await bootstrapAndOutbox(client,settings);
 assert.equal((await client.call('/api/work',{method:'POST',headers:{origin:'http://attacker.invalid'}})).status,403,'cross-origin authenticated write rejected');
 const work=async()=>{
  const {id}=await json(client,'/api/work',{method:'POST'},202);
  await wait(async()=>{const job=await json(client,'/api/work/'+id);return job.state==='completed'},'real Queue completion');return id;
 };
 const id=await work();
 const before=(await control(name,{operation:'sql',sql:'SELECT COUNT(*) n FROM scheduled_runs'})).results[0].n;
 const time=Date.now();await control(name,{operation:'tick',time});await control(name,{operation:'tick',time});
 const after=(await control(name,{operation:'sql',sql:'SELECT COUNT(*) n FROM scheduled_runs'})).results[0].n;
 assert.ok(after>=before+2,'duplicate scheduled events execute unchanged handler');
 const response=await client.call('/app');assert.equal(response.status,200,'authenticated Start SSR');
 const html=await response.text();const asset=html.match(/<script[^>]+src="([^"]+)"/)?.[1];
 if(asset){assert.equal((await client.call(asset)).status,200,'emitted client asset')}
 const values=[];for(let i=0;i<3;i++){const start=performance.now();await work();values.push(performance.now()-start)}
 return {journey:{owner_outbox:true,one_time_token:true,write:true,queue_consumed:true,duplicate_tick_runs:after-before,ssr:true,static_asset:Boolean(asset)},write_latency:summary(values),
  async pending(){const ids=[];for(let i=0;i<6;i++)ids.push((await json(client,'/api/work',{method:'POST'},202)).id);
   for(const job of ids)assert.equal((await json(client,'/api/work/'+job)).state,'queued','committed pending work before kill');return ids},
  async recovered(ids){await control(name,{operation:'tick'});await control(name,{operation:'tick'});
   const states=[];for(const job of ids)states.push((await json(client,'/api/work/'+job)).state);
   return {committed_rows_survived:states.length===ids.length,pending_effects_completed:states.every(s=>s==='completed'),states}},
  async persistence(){assert.equal((await json(client,'/api/work/'+id)).state,'completed');assert.equal((await client.call('/app')).status,200);return {native_session:true,committed_job:true}},
 };
}
