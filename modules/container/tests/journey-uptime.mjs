import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assert,json,bootstrapAndOutbox,wait,control,performance,summary} from './common.mjs';
export async function uptimeJourney(client,settings,name){
 const run=()=>control(name,{operation:'runner'}),cleanup=async()=>{};
 try{
 const fixturePort=Number(settings.bindings.UPTIME_SYNTHETIC_PORT);
 assert.equal((await client.call('/api/overview')).status,401,'private API rejects signed-out request');
 await bootstrapAndOutbox(client,settings);
 assert.equal((await client.call('/api/monitors',{method:'POST',input:{},headers:{origin:'http://attacker.invalid'}})).status,403,'cross-origin authenticated write rejected');
 const definition={name:'Container monitor',url:'http://127.0.0.1:'+fixturePort+'/health',intervalMs:5000,retries:0,confirmSlots:1,recoverSlots:1,freshnessMs:15000};
 const monitor=await json(client,'/api/monitors',{method:'POST',input:definition},201);
 await run();assert.ok((await json(client,`/api/monitors/${monitor.id}/history`)).some(row=>row.status==='complete'&&row.observations.some(o=>o.outcome==='pass')),'real scoped runner completed actual HTTP probe');
 const destination=await json(client,'/api/notifications/destinations',{method:'POST',input:{name:'Spike mail',kind:'email',address:'subscriber@example.test'}},201);
 const pending=async()=> (await json(client,`/api/notifications/destinations/${destination.id}/test`,{method:'POST',input:{}},202)).deliveryId;
 const id=await pending();await run();
 assert.ok((await json(client,'/api/notifications')).deliveries.some(row=>row.id===id&&row.state==='accepted'),'real SQL notification consumed by scoped runner poll');
 const time=Date.now();await control(name,{operation:'tick',time});await control(name,{operation:'tick',time});
 assert.equal((await client.call('/app')).status,200,'authenticated console document');
 const values=[];for(let i=0;i<3;i++){const at=performance.now();const changed=await json(client,'/api/monitors/'+monitor.id,{method:'PATCH',input:{...definition,name:'Container monitor '+i}});assert.equal(changed.definition.name,'Container monitor '+i);values.push(performance.now()-at)}
 return {journey:{owner_outbox:true,one_time_token:true,write:true,scoped_runner:true,actual_network_probe:true,sql_job_consumed:true,duplicate_tick:true,ssr:true},write_latency:summary(values),cleanup,
  pending,
  async recovered(id){await control(name,{operation:'tick'});const before=(await json(client,'/api/notifications')).deliveries.find(row=>row.id===id);assert.ok(before,'committed job survived');await run();const after=(await json(client,'/api/notifications')).deliveries.find(row=>row.id===id);assert.equal(after.state,'accepted');const n=(await control(name,{operation:'mails'})).length;await run();assert.equal((await control(name,{operation:'mails'})).length,n,'completed notification cannot be sent twice');return{committed_rows_survived:true,state_after_worker_tick:before.state,pending_effects_completed_on_runner_poll:after.state==='accepted',duplicate_poll_extra_sends:0}},
  async persistence(){const rows=(await json(client,'/api/overview')).monitors;assert.ok(rows.some(row=>row.id===monitor.id));assert.ok((await json(client,'/api/notifications')).deliveries.some(row=>row.id===id&&row.state==='accepted'));return{native_session:true,monitor:true,completed_notification:true}},
 };
 }catch(error){await cleanup();throw error}
}
