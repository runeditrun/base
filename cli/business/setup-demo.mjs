// Mirrored from runeditrun/platform 0261033177e8e05284c037369ee9c3a85922a8aa, scripts/business/demo.mjs.
import { readFile } from 'node:fs/promises';
const company = JSON.parse(await readFile(new URL('./setup-company.json', import.meta.url), 'utf8'));
export const demoPolicy={schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:[
 {id:'internal',class:'standard',do:'autonomous'},
 {id:'context',class:'sensitive',do:'autonomous'},
 {id:'owner',class:'*',do:'approval',approver:['role:owner'],wait:'P1D'},
],spend:{none:true}};

/** The only injectable boundary is HTTP. Tokens, cookies, policy envelopes and peer bodies never enter the receipt. */
export async function setupDemo({origin,cookie,hosting='managed',waitSeconds=240,fetch:request=globalThis.fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
 const api=async(path,method='GET',body,token)=>{
  let response;
  try{response=await request(new URL(path,origin),{method,redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...(token?{'X-RER-Demo-Seed-Token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw Error('platform_transport_unavailable');}
  let answer;try{answer=await response.json();}catch{throw Error(`platform_http_${response.status}`);}
  if(!response.ok){const code=answer?.code;throw Error(typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:`platform_http_${response.status}`);}
  return answer;
 };
 const businesses=(await api('/api/business')).businesses;
 let business=businesses.find(row=>row.name===company.name);
 if(!business){
  business=(await api('/api/business','POST',{name:company.name,default_hosting:hosting,executor_preference:hosting==='self_host'?'local':'managed'})).business;
  await api('/api/business/'+encodeURIComponent(business.id)+'/profile','PUT',company.profile);
 }
 if(business.default_hosting!==hosting)throw Error('existing_demo_hosting_differs');
 const root='/api/business/'+encodeURIComponent(business.id),initial=await api(root+'/demo');
 // Return exactly the same projection after the first successful run and on every repeat.
 if(initial.complete)return initial;
 const pending=initial.seeds.filter(seed=>seed.adopted&&!seed.complete);
 if(!pending.length)return initial;
 let policy=await api(root+'/agents/policy');
 if(policy.paused)throw Error('demo_is_paused_resume_as_owner');
 const errors=new Map(),credentials=new Map(),ready=pending.filter(seed=>seed.provisioned);
 let waiting=pending.filter(seed=>!seed.provisioned);
 if(waiting.length){
  const plan=await api(root+'/demo/plan','POST',{confirmed:true});
  if(plan.plan_id&&!plan.approved)await api(root+'/plans/'+encodeURIComponent(plan.plan_id)+'/approve','POST',{});
  const deadline=now()+waitSeconds*1000;
  do{
   await api(root+'/demo/advance','POST',{});
   const status=await api(root+'/demo'),apps=(await api(root+'/apps')).apps,next=[];
   for(const seed of waiting){
    const current=status.seeds.find(row=>row.app===seed.app),installed=apps.find(row=>row.app===seed.app);
    if(current?.provisioned)ready.push(current);
    else if(installed?.failure||installed?.stage==='failed')errors.set(seed.app,'M4 provisioning failed');
    else if(installed?.waits?.length||installed?.answers_needed?.length)errors.set(seed.app,'M4 setup needs hosting, payment, domain or app answers');
    else next.push(seed);
   }
   waiting=next;
   if(waiting.length&&now()<deadline)await wait(Math.min(3000,Math.max(0,deadline-now())));
  }while(waiting.length&&now()<deadline);
  for(const seed of waiting)errors.set(seed.app,'Run the same command to resume provisioning');
 }
 const eligible=[];
 for(const seed of ready){
  try{
   // This is the shared Business sender, not a demo-specific settings signer or transport.
   const settings=await api(root+'/settings/deliver','POST',{});
   const delivery=settings.deliveries.find(row=>row.installation_id===seed.installation_id);
   if(!delivery||delivery.state!=='delivered')throw Error(delivery?.code??'settings_not_delivered');
   if(policy.revision&&!seed.no_policy_refused)throw Error('no_policy_probe_requires_fresh_demo');
   const issued=await api(root+'/agents/seed-token','POST',{seed:seed.app,installation_id:seed.installation_id,
    agent:{id:'demo:'+business.id,name:'Synthetic demo setup'},scopes:seed.scopes});
   credentials.set(seed.app,issued.access_token);
   if(!policy.revision&&!seed.no_policy_refused)await api(root+'/demo/apps/'+encodeURIComponent(seed.app)+'/door','POST',{phase:'unset'},issued.access_token);
   eligible.push(seed);
  }catch(error){errors.set(seed.app,error.message);}
 }
 if(eligible.length&&!policy.revision){
  let draft=policy.draft;
  if(draft&&JSON.stringify(draft.document)!==JSON.stringify(demoPolicy))throw Error('existing_policy_draft_requires_owner_review');
  if(!draft)draft=(await api(root+'/agents/policy/revisions','POST',{document:demoPolicy})).revision;
  await api(root+'/agents/policy/revisions/'+draft.revision+'/confirm','POST',{digest:draft.document_sha256});
  policy=await api(root+'/agents/policy');
 }
 const seeded=[];
 for(const seed of eligible){
  try{await api(root+'/demo/apps/'+encodeURIComponent(seed.app)+'/door','POST',{phase:'seed'},credentials.get(seed.app));seeded.push(seed);}
  catch(error){errors.set(seed.app,error.message);}
 }
 if(seeded.length){
  await api(root+'/pause','POST',{paused:true});
  let allPaused=true;
  for(const seed of seeded){
   try{await api(root+'/demo/apps/'+encodeURIComponent(seed.app)+'/door','POST',{phase:'paused'},credentials.get(seed.app));}
   catch(error){allPaused=false;errors.set(seed.app,error.message);}
  }
  if(allPaused)await api(root+'/pause','POST',{paused:false});
 }
 credentials.clear();
 const receipt=await api(root+'/demo');
 for(const seed of receipt.seeds)if(!seed.complete&&errors.has(seed.app))seed.cause=errors.get(seed.app);
 return receipt;
}
