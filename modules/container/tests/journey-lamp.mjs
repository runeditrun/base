import {assert,json,control,wait,delay,performance,summary} from './common.mjs';
export async function lampJourney(client,page,settings,name){
 assert.equal((await client.call('/api/app/components')).status,401,'signed-out private API');
 assert.equal((await page.call('/api/app/components')).status,404,'page hostname cannot serve private API');
 assert.equal((await client.call('/api/public/status')).status,404,'app hostname cannot serve public status');
 await json(client,'/setup',{method:'POST',headers:{authorization:'Bearer '+settings.bindings.LAMP_BOOTSTRAP_SECRET},input:{email:settings.bindings.OWNER_EMAIL,displayName:'Spike Owner',pageName:'Spike status',tagline:'Container experiment',timezone:'UTC'}},201);
 assert.equal((await client.call('/signin/request',{method:'POST',form:{email:settings.bindings.OWNER_EMAIL}})).status,202,'native sign-in request');
 const mails=await control(name,{operation:'mails'});
 const link=mails.find(m=>m.to===settings.bindings.OWNER_EMAIL||m.to?.includes?.(settings.bindings.OWNER_EMAIL))?.text?.match(/https?:\/\/\S+\/signin\/complete\/[A-Za-z0-9_-]+/)?.[0];assert.ok(link,'network-edge outbox contains real sign-in link');
 const action=new URL(link),signed=await client.call(action.pathname);assert.equal(signed.status,302,'native link sign-in');client.setCookie(signed);
 assert.equal((await client.call(action.pathname)).status,400,'native link is single use');
 await json(client,'/api/app/overview/first-run',{method:'POST',input:{}});
 assert.equal((await client.call('/api/app/overview/first-run',{method:'POST',input:{},headers:{'sec-fetch-site':'cross-site'}})).status,403,'cross-site authenticated action rejected');
 const componentInput={groupId:null,name:'Container service',description:'Spike service',internal:false,displayOrder:0,note:''};
 const {component}=await json(client,'/api/app/components',{method:'POST',input:componentInput},201);
 const publish=async({channels=[],schedule=false}={})=>{
  const {incident}=await json(client,'/api/app/incidents',{method:'POST',input:{title:'Container incident '+Date.now(),components:[{componentId:component.id,state:'Degraded performance',relationship:'Primary'}]}},201);
  const full=(await json(client,'/api/app/incidents/'+incident.id)).incident;
  const version=`${full.draft?.id??'-'}:${full.updates.length}`;
  const {draft}=await json(client,`/api/app/incidents/${incident.id}/draft`,{method:'PUT',headers:{'if-match':version},input:{lifecycle:'Investigating',affectedAudience:'Customers',customerImpact:'Testing recovery',whatStillWorks:'Public reads',details:'Evidence only',nextUpdateAt:new Date(Date.now()+3600000).toISOString()}});
  const current=(await json(client,'/api/app/incidents/'+incident.id)).incident;
  const match=`${current.draft?.id??'-'}:${current.updates.length}`;
  if(schedule){await json(client,`/api/app/incidents/${incident.id}/draft/schedule`,{method:'POST',headers:{'if-match':match},input:{publishAt:new Date(Date.now()+1500).toISOString(),channels}},202);await delay(1600);await control(name,{operation:'tick'});await control(name,{operation:'tick'});return incident.id}
  await json(client,`/api/app/incidents/${incident.id}/publish`,{method:'POST',headers:{'if-match':match},input:{channels}});return incident.id;
 };
 const incidentId=await publish({schedule:true});
 const published=(await json(client,'/api/app/incidents/'+incidentId)).incident;
 await wait(async()=>{const status=await json(page,'/api/public/status');return status.incident?.reference===published.reference},'published incident in public R2 snapshot');
 const snapshots=await control(name,{operation:'objects'});assert.ok(snapshots.objects.length>0,'real R2 snapshot objects');
 assert.equal((await client.call('/app')).status,200,'Start operator document');const publicDocument=await page.call('/');assert.equal(publicDocument.status,200,'public rendered snapshot');assert.ok((await publicDocument.text()).includes(component.name),'written component appears in public snapshot');
 assert.equal((await page.call('/subscribe',{method:'POST',form:{email:'subscriber@example.test'}})).status,202,'public subscribe');
 const subscriptionMails=await control(name,{operation:'mails'});
 const subscriptionLink=subscriptionMails.map(m=>m.text??'').join('\n').match(/https?:\/\/[^\s]+\/confirm-subscription\/[^\s<>"']+/)?.[0];assert.ok(subscriptionLink,'subscription confirmation captured at network edge');
 assert.equal((await page.call(new URL(subscriptionLink).pathname)).status,200,'subscriber confirms');
 await publish({channels:['email']});
 await control(name,{operation:'tick'});
 await wait(async()=>{const {deliveries}=await json(client,'/api/app/deliveries');return deliveries.length&&deliveries.every(row=>row.providerAcceptedAt)},'native SQL outbox dispatch and provider acceptance');
 return {journey:{owner_network_edge_outbox:true,one_time_token:true,both_hostnames:true,write:true,sql_outbox_consumed_on_tick:true,duplicate_tick:true,r2_objects:snapshots.objects.length,ssr:true},
  async measure(){const values=[];try{for(let i=0;i<30;i++){const at=performance.now();await json(client,'/api/app/components/'+component.id,{method:'PUT',input:{...componentInput,note:'measurement '+i}});const rows=(await json(client,'/api/app/components')).components;assert.ok(rows.some(c=>c.id===component.id&&c.note==='measurement '+i));values.push(performance.now()-at)}return {...summary(values),completed:true}}catch(error){return {...(values.length?summary(values):{n:0}),completed:false,failure:error.message}}},
  async pending(){const id=await publish({channels:['email']});await wait(async()=>{const{deliveries}=await json(client,'/api/app/deliveries');return deliveries.some(row=>!row.providerAcceptedAt&&row.outcome==='queued')},'durable pending delivery');return id},
  async recovered(){await control(name,{operation:'tick'});await wait(async()=>{const{deliveries}=await json(client,'/api/app/deliveries');return deliveries.every(row=>row.providerAcceptedAt)},'SQL outbox recovery');const first=await control(name,{operation:'mails'});await control(name,{operation:'tick'});const second=await control(name,{operation:'mails'});assert.equal(second.length,first.length,'duplicate tick cannot send again');return {committed_rows_survived:true,pending_effects_completed:true,effect:'mail accepted at test provider edge; recipient delivery unclaimed',captured_sends_after_restart:second.length,duplicate_tick_extra_sends:0}},
  async persistence(){const found=(await json(client,'/api/app/incidents/'+incidentId)).incident;assert.equal(found.id,incidentId);const{components}=await json(client,'/api/app/components');assert.ok(components.some(c=>c.id===component.id));assert.equal((await page.call('/')).status,200);return {native_session:true,incident:true,component:true,public_r2_snapshot:true,r2_objects:(await control(name,{operation:'objects'})).objects.length}},
 };
}
