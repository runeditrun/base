import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { HOSTED_ORIGIN, serveHosted } from '../../../cli/hosted-output.mjs';
import { agentConformanceNetwork } from '../../../cli/agent-network.mjs';
import { createProtocol } from '../../../modules/agent-door/conformance/protocol.mjs';
import { heldPolicy } from '../../../modules/agent-door/conformance/crypto.mjs';

// Registered in the existing reference browser journey, using its production
// build and real D1. Playwright's route is only the loopback network ingress.
export async function agentDoorPages(root) {
 const pair = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const issuer='https://synthetic-base-2.invalid', kid='synthetic-base-1', installationId=randomUUID(), token=randomUUID(), email='synthetic-base-1@example.com';
 const hosted=await serveHosted(root,{outboundService:agentConformanceNetwork,bindings:{RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,RER_OWNER_CLAIM_APP_ORIGIN:HOSTED_ORIGIN,RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify({[kid]:await webcrypto.subtle.exportKey('jwk',pair.publicKey)}),OWNER_EMAIL:email,SETUP_TOKEN:token}});
 const request=(url,init={})=>hosted.fetch(new URL(url,hosted.origin).href.slice(hosted.origin.length+1),init);
 const response=await request('/auth/bootstrap',{method:'POST',headers:{Origin:hosted.origin,'Content-Type':'application/json'},body:JSON.stringify({token,displayName:'Synthetic Owner'})});
 assert.equal(response.status,303); const cookie=response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; '); await response.body?.cancel();
 const surface=JSON.parse(await readFile(join(root,'agent-surface.json'),'utf8')), points=[];
 const c=createProtocol({fetch:request,origin:hosted.origin,surface,signer:{issuer,installationId,kid,privateKey:pair.privateKey},person:{email,cookie},agentId:randomUUID(),business:'synthetic-base-1',seq:0,revision:0,points});
 let browser;
 try {
  await c.adopt(heldPolicy());
  const created=await c.tool('base.people.create',{name:'Synthetic Customer',email:'synthetic-base-3@example.com',idempotency_key:randomUUID()});
  assert.equal(created.result.isError,false); const reviewId=created.result._meta['com.runeditrun/review'].id;
  const pending=await c.tool('base.access.invite',{name:'Synthetic Teammate',email:'synthetic-base-2@example.com',role:'member',idempotency_key:randomUUID()});
  assert.equal(pending.result.resultType,'input_required'); const id=pending.result._meta['com.runeditrun/approval'].id;
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
  const context=await browser.newContext();
  await context.route(`${hosted.origin}/**`,async route=>{
   const req=route.request(), headers=await req.allHeaders();
   const answer=await request(req.url(),{method:req.method(),headers,...(req.postDataBuffer()?{body:req.postDataBuffer()}: {})});
   await route.fulfill({status:answer.status,headers:Object.fromEntries(answer.headers),body:Buffer.from(await answer.arrayBuffer())});
  });
  const [name,value]=cookie.split('='); await context.addCookies([{name,value,url:hosted.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
  const page=await context.newPage(), directory=process.env.AGENT_DOOR_SCREENSHOTS??join(root,'.cache','agent-door-screenshots'); await mkdir(directory,{recursive:true});
  const screenshots=[];
  for(const width of [1440,390]) for(const path of ['/agents',`/agents/approvals/${id}`]) {
   await page.setViewportSize({width,height:1000}); await page.goto(hosted.origin+path,{waitUntil:'networkidle'});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${path} overflows at ${width}`);
   const results=await new AxeBuilder({page}).analyze(); assert.deepEqual(results.violations.filter(item=>['serious','critical'].includes(item.impact)),[],`${path} axe at ${width}`);
   const small=await page.locator('button,a,select,summary,input:not([type=hidden])').evaluateAll(elements=>elements.filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.height<44}).map(el=>el.outerHTML)); assert.deepEqual(small,[],`${path} touch targets at ${width}`);
   const file=join(directory,`${path==='/agents'?'agents':'approval'}-${width}.png`);await page.screenshot({path:file,fullPage:true});screenshots.push(file);
  }
  await page.locator('[data-approval-action="approve"]').click(); await page.waitForLoadState('networkidle'); await page.getByText('approved',{exact:true}).waitFor();
  await page.goto(hosted.origin+'/agents',{waitUntil:'networkidle'}); await page.locator(`[data-review-id="${reviewId}"] [data-review-action="flag"]`).click(); await page.getByText('flagged',{exact:false}).first().waitFor();
  await page.locator(`[data-review-id="${reviewId}"] [data-review-action="reviewed"]`).click(); await page.waitForLoadState('networkidle'); await page.locator(`[data-review-id="${reviewId}"]`).waitFor({state:'detached'});
  await page.locator('[data-agents-pause]').click(); await page.getByText('Agents are paused.',{exact:true}).waitFor(); await page.locator('[data-agents-pause]').click(); await page.getByText('Agents are not paused.',{exact:true}).waitFor();
  const audit=(await c.personJson('/agents/api/audit')).rows;
  for(const count of await page.locator('[data-agents-count]').evaluateAll(els=>els.map(el=>({class:el.dataset.class,decision:el.dataset.decision,count:Number(el.textContent)})))) assert.equal(count.count,audit.filter(row=>row.decision===count.decision&&row.classes.some(item=>item.class===count.class)).length);
  await context.clearCookies();await page.goto(hosted.origin+'/agents');assert.equal(await page.locator('[data-review-id],[data-approval-id],[data-agents-count]').count(),0);
  assert.deepEqual(points.filter(point=>!point.ok),[]);
  return {pages:2,widths:[1440,390],axe:'passed',overflow:false,screenshots};
 } finally { await browser?.close(); await hosted.close(); }
}
