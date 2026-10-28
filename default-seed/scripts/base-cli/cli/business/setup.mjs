// Mirrors runeditrun/platform scripts/business/demo/setup.mjs and demo inputs at
// f8f572350a209e045fc7f1e858fcc35682ce9bdf. Keep Business calls and receipts aligned.
import {open} from 'node:fs/promises'
import {constants} from 'node:fs'
import company from './demo-company.json' with {type:'json'}
import startingPolicy from './demo-policy.json' with {type:'json'}

export class DemoRefusal extends Error {
 constructor(code,status=409){super(code);this.code=code;this.status=status}
}
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'
 ?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value)
export const safeCode=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,100}$/.test(value)?value:'demo_request_failed'
export function platformOrigin(value) {
 const url=new URL(value)
 if(url.origin!==value||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new DemoRefusal('demo_origin_invalid',400)
 return url.origin
}

/** All mutations enter the ordinary authenticated Business doors. request is the
 * network edge, also used by the SQLite-backed integration registration. */
export async function setupDemo({origin,request=fetch,cookie,confirmPolicy=false,hosting='self_host'}) {
 origin=platformOrigin(origin)
 if(!['self_host','managed','assisted'].includes(hosting))throw new DemoRefusal('demo_hosting_invalid',400)
 const call=async(path,method='GET',body)=>{
  let response
  try {
   response=await request(new Request(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(60000),
    headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}))
  } catch {throw new DemoRefusal('demo_transport_unavailable',503)}
  let data
  try {data=await response.json()}catch{throw new DemoRefusal('demo_response_invalid',response.status)}
  if(!response.ok)throw new DemoRefusal(safeCode(data.code),response.status)
  return data
 }
 const readiness=await call('/api/business/demo/seeds')
 const businesses=(await call('/api/business')).businesses
 const matches=businesses.filter(b=>b.name===company.name&&b.primary_domain===null)
 if(matches.length>1)throw new DemoRefusal('demo_business_ambiguous')
 let business=matches[0],created=false
 if(!business) {
  try {
   business=(await call('/api/business','POST',{name:company.name,default_hosting:hosting,executor_preference:'local'})).business
   created=true
  } catch(error) {
   if(error.code!=='business_duplicate')throw error
   business=(await call('/api/business')).businesses.find(b=>b.name===company.name&&b.primary_domain===null)
   if(!business)throw error
  }
 }
 if(business.default_hosting!==hosting)throw new DemoRefusal('demo_hosting_mismatch')
 const root='/api/business/'+encodeURIComponent(business.id)
 const beforeProfile=(await call(root+'/profile')).profile
 const profilePatch={}
 for(const [name,value] of Object.entries(company.profile)) {
  if(beforeProfile[name]===null||beforeProfile[name]===undefined)profilePatch[name]=value
  else if(beforeProfile[name]!==value)throw new DemoRefusal('demo_profile_requires_owner')
 }
 if(Object.keys(profilePatch).length)await call(root+'/profile','PUT',profilePatch)
 let policy=await call(root+'/agents/policy'),policyCreated=false
 if(policy.revision&&canonical(policy.revision.document)!==canonical(startingPolicy))throw new DemoRefusal('demo_policy_requires_owner')
 if(!policy.revision) {
  let revision=policy.draft
  if(revision&&canonical(revision.document)!==canonical(startingPolicy))throw new DemoRefusal('demo_draft_requires_owner')
  if(!revision) {
   revision=(await call(root+'/agents/policy/revisions','POST',{document:startingPolicy})).revision
   policyCreated=true
  }
  if(confirmPolicy) {
   await call(root+'/agents/policy/revisions/'+revision.revision+'/confirm','POST',{digest:revision.document_sha256})
   policy=await call(root+'/agents/policy')
  }
 }
 const beforeApps=(await call(root+'/apps')).apps
 const seeds=readiness.seeds.map(seed=>({app:seed.app,name:seed.name,required:seed.required,
  state:seed.state,message:seed.message,source:seed.source,fixture:seed.fixture,
  fixture_state:'not_loaded',token_ids:[],door_state:'unavailable'}))
 const available=seeds.filter(seed=>seed.state==='available')
 let plansCreated=0
 if(available.length) {
  // A normal approved M4 plan owns every installation; never insert an app or
  // turn a task green here. Retain every existing choice in its next revision.
  const plans=(await call(root+'/plans')).data
  let latest=plans.sort((a,b)=>b.revision-a.revision)[0]
  let plan=latest?(await call(root+'/plans/'+latest.id)).data:null
  const planned=new Set(plan?.items.filter(item=>item.decision!=='stays').map(item=>item.target_seed)??[])
  const missing=available.filter(seed=>!planned.has(seed.app))
  if(missing.length) {
   const items=[...(plan?.items??[]).map(item=>({tool_id:item.tool_id,decision:item.decision,target_seed:item.target_seed,importer_status:item.importer_status,wave:item.wave})),
    ...missing.map(seed=>({tool:{vendor:'Demo: '+seed.name,function:readiness.seeds.find(row=>row.app===seed.app).purpose},decision:'runs_beside',target_seed:seed.app,wave:0}))]
   plan=(await call(root+'/plans','POST',{items})).data
   plansCreated++
  }
  if(plan?.state==='draft') {
   for(const item of plan.items)await call(root+'/inventory/'+item.tool_id,'PATCH',{answer:'uses'})
   // Re-read the approved snapshot below: M4 resolves its own source pins.
   plan=(await call(root+'/plans/'+plan.id+'/approve','POST',{})).data
  }
  if(plan?.state!=='approved')throw new DemoRefusal('demo_plan_not_approved')
  const snapshot=typeof plan.snapshot==='object'?plan.snapshot:JSON.parse(plan.snapshot_json)
  for(const seed of available) {
   if(snapshot.sources?.[seed.app]?.commit!==seed.source.commit) {
    seed.state='approved_source_mismatch';seed.message='The approved source differs from the reviewed adoption.'
   }
  }
 }
 const apps=(await call(root+'/apps')).apps
 for(const seed of available) {
  if(seed.state!=='available')continue
  const app=apps.find(app=>app.app===seed.app)
  if(app?.failure) {
   seed.state='failed';seed.message=safeCode(app.failure.code)
  } else if(app?.stage!=='ready') {
   seed.state='provisioning';seed.message='Continue the existing M4 setup task; no deployment or owner claim is assumed.'
  } else {
   seed.state='agent_token_issuer_unavailable';seed.message='App provisioned; Business seed MCP token issuance is unavailable.'
  }
  seed.installation_id=app?.installation_id??null
  seed.door_state=app?.door?.state??'unavailable'
 }
 const provisioned=apps.filter(app=>available.some(seed=>seed.app===app.app)&&app.stage==='ready').length
 const already= !created&&!Object.keys(profilePatch).length&&!policyCreated&&!plansCreated
 const counts={businesses_before:created?0:1,businesses_after:1,apps_before:beforeApps.length,apps_after:apps.length,
  adopted:available.length,provisioned,fixtures_loaded:0,token_ids:0,plans_created:plansCreated}
 return {schema:'rer-demo-receipt/1',synthetic:true,business_id:business.id,hosting,
  status:'dependencies_required',setup_status:already?'already provisioned':'setup recorded',complete:false,
  policy:{id:policy.revision?business.id+':'+policy.revision.revision:null,revision:policy.revision?.revision??null,
   confirmed:!!policy.revision,paused:policy.paused,spend:'none'},
  counts,seeds,dependencies:[...readiness.dependencies,...(!policy.revision?[{code:'owner_policy_confirmation_required'}]:[])],
  proof:{no_policy:'not_run',with_policy:'not_run',attribution_audit:'not_run',pause:'not_run'}}
}

export async function sessionCookie(file) {
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
 try {
  const info=await handle.stat()
  if(!info.isFile()||(info.mode&0o7777)!==0o600||info.uid!==process.getuid())throw new DemoRefusal('demo_session_file_permissions',400)
  const body=JSON.parse(await handle.readFile('utf8'))
  if(Object.keys(body).length!==1||typeof body.cookie!=='string'||!body.cookie||/[\r\n]/.test(body.cookie))throw new DemoRefusal('demo_session_file_invalid',400)
  return body.cookie
 } finally {await handle.close()}
}
