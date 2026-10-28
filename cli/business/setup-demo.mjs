// Mirrored from runeditrun/platform c62af17e4d64105f84b71dd89ae012cb0ebccc4c, scripts/business/demo.mjs.
import { readFile } from 'node:fs/promises';
const company = JSON.parse(await readFile(new URL('./setup-company.json', import.meta.url), 'utf8'));
export const demoPolicy={schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:[
 {id:'internal',class:'standard',do:'autonomous'},
 {id:'context',class:'sensitive',do:'autonomous'},
 {id:'owner',class:'*',do:'approval',approver:['role:owner'],wait:'P1D'},
],spend:{none:true}};

/** The only injectable boundary is HTTP. Tokens, cookies, policy envelopes and peer bodies never enter the receipt. */
export async function setupDemo({origin,cookie,hosting='managed',waitSeconds=240,fetch:request=globalThis.fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
 const api=async(path,method='GET',body)=>{
  let response;
  try{response=await request(new URL(path,origin),{method,redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw Error('platform_transport_unavailable');}
  let answer;try{answer=await response.json();}catch{throw Error(`platform_http_${response.status}`);}
  if(!response.ok){const code=answer?.code;throw Error(typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:`platform_http_${response.status}`);}
  return answer;
 };
 const businesses=(await api('/api/business')).businesses;
 let business=businesses.find(row=>row.name===company.name),created=false;
 if(!business){business=(await api('/api/business','POST',{name:company.name,default_hosting:hosting,executor_preference:hosting==='self_host'?'local':'managed'})).business;created=true;}
 if(business.default_hosting!==hosting)throw Error('existing_demo_hosting_differs');
 const root='/api/business/'+encodeURIComponent(business.id);
 if(created)await api(root+'/profile','PUT',company.profile);
 const initial=await api(root+'/demo');
 const adopted=initial.seeds.filter(row=>row.state==='adopted');
 const receipt={synthetic:true,business_id:business.id,business_created:created,policy_id:null,
  required_total:initial.seeds.filter(row=>row.required).length,provisioned:0,already_provisioned:0,required_provisioned:0,seeds:[]};
 const completed=new Map(initial.receipts.filter(row=>row.seeded&&row.pause_refused).map(row=>[row.app,row]));
 for(const seed of initial.seeds){
  if(seed.state!=='adopted')receipt.seeds.push({...seed});
  else if(completed.has(seed.app)){
   const saved=completed.get(seed.app);if(seed.required)receipt.required_provisioned++;receipt.seeds.push({app:seed.app,state:'already provisioned',token_id:saved.token_id,consent_id:saved.consent_id,policy_id:saved.policy_id,
    no_policy_refused:!!saved.no_policy_refused,policy_call:!!saved.policy_call,attributed:!!saved.attributed,pause_refused:true,fixture_calls:saved.fixture_calls});
   receipt.already_provisioned++;
  }
 }
 // A repeated completed run is a read. It neither rotates credentials nor pauses somebody's work.
 const pending=adopted.filter(seed=>!completed.has(seed.app));
 if(!pending.length&&adopted.length){receipt.policy_id=initial.receipts.find(row=>row.policy_id)?.policy_id??null;return receipt;}
 const plan=await api(root+'/demo/plan','POST',{confirmed:true});
 if(plan.plan_id&&!plan.approved)await api(root+'/plans/'+encodeURIComponent(plan.plan_id)+'/approve','POST',{});
 let policy=await api(root+'/agents/policy');
 if(policy.paused)throw Error('demo_is_paused_resume_as_owner');
 const deadline=now()+waitSeconds*1000,ready=[];
 let waiting=[...pending];
 do{
  if(!waiting.length)break;
  await api(root+'/demo/advance','POST',{});
  const apps=(await api(root+'/apps')).apps,next=[];
  for(const seed of waiting){
   const installed=apps.find(row=>row.app===seed.app);
   if(installed?.stage==='ready')ready.push(seed);
   else if(installed?.failure||installed?.stage==='failed')receipt.seeds.push({app:seed.app,state:'failed',cause:'M4 provisioning failed',code:installed?.failure?.code??'provisioning_failed'});
   else if(installed?.waits?.length||installed?.answers_needed?.length)receipt.seeds.push({app:seed.app,state:'waiting for owner',cause:'M4 setup needs hosting, payment, domain or app answers'});
   else next.push(seed);
  }
  waiting=next;
  if(waiting.length&&now()<deadline)await wait(Math.min(3000,Math.max(0,deadline-now())));
 }while(waiting.length&&now()<deadline);
 for(const seed of waiting)receipt.seeds.push({app:seed.app,state:'provisioning',cause:'Run the same command to resume'});
 // Never clear a policy to demonstrate its absence. Only a fresh Business can establish this observation.
 const eligible=[];
 for(const seed of ready){
  try{
   if(!policy.revision)await api(root+'/demo/apps/'+encodeURIComponent(seed.app)+'/door','POST',{phase:'unset'});
   else if(!initial.receipts.some(row=>row.app===seed.app&&row.no_policy_refused))throw Error('no_policy_probe_requires_fresh_demo');
   eligible.push(seed);
  }catch(error){receipt.seeds.push({app:seed.app,state:'failed',cause:error.message});}
 }
 if(!policy.revision){
  let draft=policy.draft;
  if(draft&&JSON.stringify(draft.document)!==JSON.stringify(demoPolicy))throw Error('existing_policy_draft_requires_owner_review');
  if(!draft)draft=(await api(root+'/agents/policy/revisions','POST',{document:demoPolicy})).revision;
  await api(root+'/agents/policy/revisions/'+draft.revision+'/confirm','POST',{digest:draft.document_sha256});
  policy=await api(root+'/agents/policy');
 }
 receipt.policy_id=policy.revision.revision;
 const seeded=[];
 for(const seed of eligible){
  try{const result=await api(root+'/demo/apps/'+encodeURIComponent(seed.app)+'/door','POST',{phase:'seed'});seeded.push(seed);receipt.seeds.push(result);receipt.provisioned++;if(seed.required)receipt.required_provisioned++;}
  catch(error){receipt.seeds.push({app:seed.app,state:'failed',cause:error.message});}
 }
 if(seeded.length){
  // The existing Business pause broadcasts a signed control sequence. Keep failures paused for owner recovery.
  await api(root+'/pause','POST',{paused:true});
  let allPaused=true;
  for(const seed of seeded){
   const row=receipt.seeds.find(row=>row.app===seed.app);
   try{Object.assign(row,await api(root+'/demo/apps/'+encodeURIComponent(seed.app)+'/door','POST',{phase:'paused'}));row.state='provisioned';}
   catch(error){allPaused=false;row.state='failed';row.cause=error.message;receipt.provisioned--;if(seed.required)receipt.required_provisioned--;}
  }
  if(allPaused)await api(root+'/pause','POST',{paused:false});
  else receipt.paused=true;
 }
 return receipt;
}

