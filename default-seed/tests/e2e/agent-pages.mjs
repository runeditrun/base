import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { HOSTED_ORIGIN, serveHosted } from '../../scripts/base-cli/cli/hosted-output.mjs';
import { agentConformanceNetwork } from '../../scripts/base-cli/cli/agent-network.mjs';
import { createProtocol } from '../../scripts/base-cli/modules/agent-door/conformance/protocol.mjs';
import { accessToken, autonomousPolicy, heldPolicy } from '../../scripts/base-cli/modules/agent-door/conformance/crypto.mjs';
import { signSettings, testDocument, testTrust } from '../../../modules/business-settings/testing/index.mjs';

const cookieOf = response => {
 assert.equal(response.status,303);
 return response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
};
const approvalId = answer => {
 assert.equal(answer.result.resultType,'input_required');
 return answer.result._meta['com.runeditrun/approval'].id;
};
const successful = answer => {
 assert.equal(answer.result?.isError,false,JSON.stringify(answer.message ?? answer.result));
 return answer.result.structuredContent;
};
async function approvedPersonRead(c,id) {
 const pending=await c.tool('base.people.read',{id});approvalId(pending);
 const approved=await c.decideApproval(pending);assert.equal(approved.ok,true);assert.equal(approved.body.approval.state,'executed');
 return successful(await c.mcp('tools/call',{name:'base.people.read',arguments:{id},requestState:pending.result.requestState})).person;
}
async function trustBindings(email) {
 const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const issuer='https://synthetic-base-2.invalid',kid='synthetic-base-1',installationId=randomUUID();
 return { signer:{issuer,kid,installationId,privateKey:pair.privateKey}, bindings:{
  RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,RER_OWNER_CLAIM_APP_ORIGIN:HOSTED_ORIGIN,
  RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify({[kid]:await webcrypto.subtle.exportKey('jwk',pair.publicKey)}),
  RER_BUSINESS_TRUST:JSON.stringify(testTrust({email})),
 } };
}
async function mapBusiness(request,email,ownerId,team=null) {
 const response=await request('/api/rer/business-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  settings:await signSettings(testDocument({email,owner_id:ownerId,team,business:'synthetic-base-1'})),
 })});
 assert.equal(response.status,200,await response.text());
}

// Registered in the reference browser journey, with the production Worker and
// real D1. The browser route supplies loopback ingress only.
export async function agentDoorPages(root) {
 const email='synthetic-base-1@example.com',token=randomUUID(),ownerId=randomUUID();
 const trust=await trustBindings(email);
 const hosted=await serveHosted(root,{outboundService:agentConformanceNetwork,bindings:{...trust.bindings,OWNER_EMAIL:email,SETUP_TOKEN:token}});
 const request=(url,init={})=>hosted.fetch(new URL(url,hosted.origin).href.slice(hosted.origin.length+1),init);
 const surface=JSON.parse(await readFile(join(root,'agent-surface.json'),'utf8')),points=[];
 let browser,result;
 try {
  const response=await request('/auth/bootstrap',{method:'POST',headers:{Origin:hosted.origin,'Content-Type':'application/json'},body:JSON.stringify({token,displayName:'Synthetic Owner'})});
  const cookie=cookieOf(response);await response.body?.cancel();
  await mapBusiness(request,email,ownerId);
  const c=createProtocol({fetch:request,origin:hosted.origin,surface,signer:trust.signer,person:{sub:ownerId,email,cookie},consent:randomUUID(),agentId:randomUUID(),business:'synthetic-base-1',seq:0,revision:0,points});
  const policy=heldPolicy();policy.spend={caps:[{seed:'base',specialist:'operations',microusd_per_day:1000000}]};
  await c.adopt(policy);
  const created=await c.tool('base.people.create',{name:'Synthetic Customer',email:'synthetic-base-3@example.com',idempotency_key:randomUUID()});
  const person=successful(created),reviewId=created.result._meta['com.runeditrun/review'].id;
  const note=await c.tool('base.people.note',{id:person.id,body:'A note the owner can undo.',idempotency_key:randomUUID()});
  const noteId=successful(note).id,noteReviewId=note.result._meta['com.runeditrun/review'].id;
  const inviteArgs={name:'Synthetic Teammate',email:'synthetic-base-2@example.com',role:'member',idempotency_key:randomUUID()};
  const id=approvalId(await c.tool('base.access.invite',inviteArgs));
  const eraseId=approvalId(await c.tool('base.people.erase',{id:person.id,idempotency_key:randomUUID()}));
  const saved=(await c.personJson(`/agents/api/approvals/${id}`)).approval;
  assert.deepEqual(saved.summary,{target:{name:inviteArgs.name,email:inviteArgs.email},recipients:[inviteArgs.email],role:inviteArgs.role});
  const before=await c.witness();
  for(const action of ['approve','reject']) {
   const stale=await c.personRequest(`/agents/api/approvals/${id}/${action}`,{method:'POST',body:JSON.stringify({revision:saved.revision,summary_sha256:'0'.repeat(64)})});
   assert.equal(stale.status,409);assert.equal((await stale.json()).code,'approval_summary_mismatch');
  }
  assert.deepEqual(await c.witness(),before,'a stale summary cannot decide or execute an invitation');
  assert.equal((await c.personJson(`/agents/api/approvals/${id}`)).approval.state,'pending');
  browser=await chromium.launch({headless:true,executablePath:process.env.RER_TEST_CHROMIUM,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
  const context=await browser.newContext();
  await context.route(`${hosted.origin}/**`,async route=>{
   const req=route.request(),headers=await req.allHeaders();
   const answer=await request(req.url(),{method:req.method(),headers,...(req.postDataBuffer()?{body:req.postDataBuffer()}: {})});
   await route.fulfill({status:answer.status,headers:Object.fromEntries(answer.headers),body:Buffer.from(await answer.arrayBuffer())});
  });
  const [name,value]=cookie.split('=');await context.addCookies([{name,value,url:hosted.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
  const page=await context.newPage(),directory=process.env.AGENT_DOOR_SCREENSHOTS??join(root,'.cache','agent-door-screenshots');
  await mkdir(directory,{recursive:true});const screenshots=[];
  const captureState=async label=>{ for(const width of [1440,390]) { await page.setViewportSize({width,height:1000}); if(width===1440) assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} overflows at ${width}`); const file=join(directory,`${label}-${width}.png`);await page.screenshot({path:file,fullPage:true});screenshots.push(file); } await page.setViewportSize({width:1440,height:1000}); };
  for(const width of [1440,390]) for(const [label,path] of [['agents','/agents'],['approval',`/agents/approvals/${id}`],['erase',`/agents/approvals/${eraseId}`]]) {
   await page.setViewportSize({width,height:1000});await page.goto(hosted.origin+path,{waitUntil:'networkidle'});
   if(width===1440) {
   if(label==='agents') {
    assert.match(await page.locator('[data-review-id="'+reviewId+'"] [data-approval-summary]').innerText(),/Synthetic Customer/);
    assert.match(await page.locator('[data-spend-caps="not-enforced"]').innerText(),/not enforced/);
    const card=page.locator('li').filter({has:page.locator(`[data-approval-id="${id}"]`)});
    assert.match(await card.locator('[data-approval-summary]').innerText(),/synthetic-base-2@example.com/);
   } else {
    const summary=await page.locator('[data-approval-summary]').innerText();
    if(label==='approval') {assert.match(summary,/synthetic-base-2@example.com/);assert.match(summary,/member/);}
    else {assert.ok(summary.includes(person.id));assert.match(summary,/Synthetic Customer/);}
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${path} overflows at ${width}`);
   const results=await new AxeBuilder({page}).analyze();
   assert.deepEqual(results.violations.filter(item=>['serious','critical'].includes(item.impact)),[],`${path} axe at ${width}`);
   const small=await page.locator('button,a,select,summary,input:not([type=hidden])').evaluateAll(elements=>elements.filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.height<44}).map(el=>el.outerHTML));
   assert.deepEqual(small,[],`${path} touch targets at ${width}`);
   }
   const file=join(directory,`${label}-${width}.png`);await page.screenshot({path:file,fullPage:true});screenshots.push(file);
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(hosted.origin+`/agents/approvals/${id}`,{waitUntil:'networkidle'});
  const [approved]=await Promise.all([
   page.waitForResponse(response=>response.url().endsWith(`/agents/api/approvals/${id}/approve`)),
   page.locator('[data-approval-action="approve"]').click(),
  ]);
  assert.deepEqual(approved.request().postDataJSON(),{revision:saved.revision,summary_sha256:saved.summary_sha256});
  await page.locator('[data-approval-state]').filter({hasText:'executed'}).waitFor();await captureState('executed');
  const invited=successful(await c.tool('base.access.invite',inviteArgs));
  const nativeInvitation=(await c.personJson('/auth/operators')).find(operator=>operator.id===invited.id);
  assert.equal(nativeInvitation.email,inviteArgs.email);assert.equal(nativeInvitation.role,inviteArgs.role);
  const approvedInvitation=(await c.personJson(`/agents/api/approvals/${id}`)).approval;
  assert.equal(approvedInvitation.approvals[0].name,'Synthetic Owner');
  const events=successful(await c.tool('base.events.list',{limit:200})).events;
  const invitation=events.find(event=>event.type==='operator.invited');
  assert.equal(invitation,undefined,'An unregistered operator resource must not expose its event.');
  await page.goto(hosted.origin+'/agents',{waitUntil:'networkidle'});
  await page.locator(`[data-review-id="${noteReviewId}"] [data-review-action="undo"]`).click();
  await page.locator(`[data-review-id="${noteReviewId}"]`).waitFor({state:'detached'});
  const nativePerson=await approvedPersonRead(c,person.id);
  assert.equal(nativePerson.notes.some(note=>note.id===noteId),false);
  assert.equal((await c.personJson(`/api/people/${person.id}/export`)).notes.some(note=>note.id===noteId),false);
  const undone=successful(await c.tool('base.events.list',{limit:200})).events.find(event=>event.type==='person.note.removed');
  assert.equal(undone.actor.kind,'person');assert.equal(undone.actor.person.name,'Synthetic Owner');
  await page.locator(`[data-review-id="${reviewId}"] [data-review-action="flag"]`).click();
  await page.locator(`[data-review-id="${reviewId}"]`).getByText('standard · flagged',{exact:true}).waitFor();
  await page.locator(`[data-review-id="${reviewId}"] [data-review-action="reviewed"]`).click();
  await page.locator(`[data-review-id="${reviewId}"]`).waitFor({state:'detached'});
  await page.locator('[data-agents-pause]').click();await page.getByText('Agents are paused.',{exact:true}).waitFor();
  await page.locator('[data-agents-pause]').click();await page.getByText('Agents are not paused.',{exact:true}).waitFor();
  const rejectedId=approvalId(await c.tool('base.access.invite',{...inviteArgs,email:'synthetic-rejected@example.com',idempotency_key:randomUUID()}));
  await page.goto(hosted.origin+`/agents/approvals/${rejectedId}`,{waitUntil:'networkidle'});
  const [rejected]=await Promise.all([page.waitForResponse(response=>response.url().endsWith(`/${rejectedId}/reject`)),page.locator('[data-approval-action="reject"]').click()]);
  assert.equal(typeof rejected.request().postDataJSON().summary_sha256,'string');
  await page.locator('[data-approval-state]').filter({hasText:'rejected'}).waitFor();await captureState('rejected');
  await c.adopt(heldPolicy());
  await page.goto(hosted.origin+`/agents/approvals/${eraseId}`,{waitUntil:'networkidle'});
  await page.locator('[data-approval-action="approve"]').click();
  await page.locator('[data-approval-state]').filter({hasText:'refused'}).waitFor();
  assert.equal(await page.locator('[data-approval-code]').innerText(),'approval_evidence_changed');await captureState('refused');
  assert.equal((await approvedPersonRead(c,person.id)).name,'Synthetic Customer');
  await page.goto(hosted.origin+'/agents',{waitUntil:'networkidle'});
  const audit=(await c.personJson('/agents/api/audit')).rows;
  for(const count of await page.locator('[data-agents-count]').evaluateAll(els=>els.map(el=>({class:el.dataset.class,decision:el.dataset.decision,count:Number(el.textContent)})))) {
   assert.equal(count.count,audit.filter(row=>row.decision===count.decision&&row.classes.some(item=>item.class===count.class)).length);
  }
  await context.clearCookies();await page.goto(hosted.origin+'/agents');
  assert.equal(await page.locator('[data-review-id],[data-approval-id],[data-agents-count]').count(),0);await captureState('signed-out');
  assert.deepEqual(points.filter(point=>!point.ok),[]);
  result={pages:3,widths:[1440,390],axe:'passed',overflow:false,screenshots,summary:'passed',personUndo:'passed'};
 } finally {await browser?.close();await hosted.close();}
 return {...result,allowList:await baseAllowListProof(root)};
}

// Reconfigure the real Worker's binding at the existing emitted ingress, while
// retaining its D1 and the same live Business token throughout the three phases.
export async function baseAllowListProof(root) {
 const {emittedRuntime,owner,setupToken}=await import('../operator-auth/emitted-runtime.mjs');
 const trust=await trustBindings(owner),ownerId=randomUUID(),adminId=randomUUID(),adminEmail='synthetic-admin@example.test';
 const bindings={...trust.bindings};delete bindings.RER_OWNER_CLAIM_APP_ORIGIN;
 const runtime=await emittedRuntime({bindings});
 const request=(url,{headers,body,...init}={})=>runtime.call(new URL(url,runtime.origin).pathname,{...init,headers:Object.fromEntries(new Headers(headers)),body});
 try {
  const boot=await runtime.call('/auth/bootstrap',{method:'POST',input:{token:setupToken,displayName:'Allow-list Owner'}});
  cookieOf(boot);await boot.body?.cancel();
  await mapBusiness(request,owner,ownerId,[{id:adminId,email:adminEmail,name:'Allow-list Admin',role:'admin',invite:0}]);
  const link=new URL(runtime.mails.at(-1).text.match(/https?:\/\/\S+/)[0]);
  const joined=await runtime.call('/auth/confirm',{method:'POST',input:{token:link.searchParams.get('token')}});
  const cookie=cookieOf(joined);await joined.body?.cancel();
  const native=await runtime.db.prepare('SELECT id,role,status FROM oa_operators WHERE email=?').bind(adminEmail).first();
  assert.equal(native.role,'admin');assert.equal(native.status,'active');assert.notEqual(native.id,adminId);
  const surface=JSON.parse(await readFile(join(root,'agent-surface.json'),'utf8')),points=[];
  const c=createProtocol({fetch:request,origin:runtime.origin,surface,signer:trust.signer,person:{sub:adminId,email:adminEmail,cookie},consent:randomUUID(),agentId:randomUUID(),business:'synthetic-base-1',seq:0,revision:0,points});
  await c.adopt(autonomousPolicy());const token=await accessToken(c);
  const initial=successful(await c.tool('base.people.create',{name:'Allow-list Native Person',email:'allow-person@example.test',idempotency_key:randomUUID()},{token}));
  const uri=`base://person/${initial.id}`;
  const admitted=async phase=>{
   const listed=await c.mcp('tools/list',{}, {token});assert.equal(listed.status,200);assert.ok(listed.result.tools.some(tool=>tool.name==='base.people.create'));
   assert.ok(successful(await c.tool('base.people.list',{}, {token})).people.some(person=>person.id===initial.id));
   const created=successful(await c.tool('base.people.create',{name:`Allow-list ${phase}`,email:`allow-${phase}@example.test`,idempotency_key:randomUUID()},{token}));
   assert.ok(await runtime.db.prepare('SELECT id FROM people WHERE id=?').bind(created.id).first());
   const read=await c.mcp('resources/read',{uri},{token});assert.equal(read.status,200);assert.equal(JSON.parse(read.result.contents[0].text).id,initial.id);
  };
  const configure=async allowList=>runtime.redeploy((source,path)=>{
   if(!path.endsWith('/test-demo-entry.mjs')) return source;
   const call='return worker.fetch(new Request(request, { headers }), env, execution);';
   assert.ok(source.includes(call),'emitted ingress passes the production binding object to the real Worker');
   return source.replace(call,`return worker.fetch(new Request(request, { headers }), { ...env, AUTH_ALLOW_LIST: ${JSON.stringify(allowList)} }, execution);`);
  });
  await admitted('before');
  const before=(await runtime.db.prepare('SELECT id,name,email FROM people ORDER BY id').all()).results;
  const beforeAudit=(await runtime.db.prepare('SELECT id,actor,action,entity_id,details FROM audit_events ORDER BY id').all()).results;
  await configure(owner);
  for(const [method,params] of [['tools/list',{}],['tools/call',{name:'base.people.list',arguments:{}}],['tools/call',{name:'base.people.create',arguments:{name:'Must not exist',email:'refused@example.test',idempotency_key:randomUUID()}}],['resources/read',{uri}]]) {
   const refused=await c.mcp(method,params,{token});assert.equal(refused.status,401,`${method} must lose excluded sponsor authority`);
  }
  assert.deepEqual((await runtime.db.prepare('SELECT id,name,email FROM people ORDER BY id').all()).results,before);
  assert.deepEqual((await runtime.db.prepare('SELECT id,actor,action,entity_id,details FROM audit_events ORDER BY id').all()).results,beforeAudit);
  assert.deepEqual(await runtime.db.prepare('SELECT id,role,status FROM oa_operators WHERE email=?').bind(adminEmail).first(),native,'exclusion does not delete or demote the local person');
  await configure(`${owner},${adminEmail}`);await admitted('reincluded');
  assert.deepEqual(points.filter(point=>!point.ok),[]);
  return {sponsor:'active-native-admin',token:'same-live-token',before:'admitted',excluded:'401-no-effect',reincluded:'admitted'};
 } finally {await runtime.close();}
}
