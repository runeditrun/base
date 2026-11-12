import { runCase } from './fold-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflare } from '../provider.mjs';
import { deploy } from '../deploy.mjs';
import { hash } from '../validation.mjs';
import { defaultStagePlan } from '../default-stage.mjs';
import { providerFixture } from './provider-fixture.mjs';

const readinessCaseRows = [];
const readinessCase = (name, run) => readinessCaseRows.push({name,run});

function setup(t) {
  const fixture=providerFixture();t.after(()=>fixture.close());
  const code='export default {scheduled() {}}';
  const artifact={version:1,source:{sha:'1'.repeat(40),tree:'2'.repeat(40)},run:{id:'17',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(code).toString('base64'),sha256:hash(code)}],assets:[],migrations:[]};
  const plan=defaultStagePlan(artifact);plan.d1=[];plan.queues=[];
  let time=0;const sleeps=[];
  return {fixture,plan,args:{api:cloudflare(fixture),plan,artifact,artifactSha256:hash(artifact),fetch:fixture.fetch,readiness:{clock:()=>time,sleep:async ms=>{sleeps.push(ms);time+=ms;}}},sleeps};
}
readinessCase('deploy waits through 404,404,200 and records every attempt in result and receipt callback',async t=>{
  const {fixture,args,sleeps}=setup(t);let calls=0;const snapshots=[];
  fixture.state.healthOverride=()=>++calls<=2?new Response('not ready',{status:404,headers:{'cf-ray':`ray-${calls}`,'content-type':'text/plain'}}):Response.json({ok:true,deployment:{sourceSha:args.artifact.source.sha,fingerprint:fixture.state.settings.bindings.find(x=>x.name==='RER_DEPLOY_FINGERPRINT').text,versionId:fixture.state.version.id}});
  const receipt=await deploy({...args,onHealth:async value=>snapshots.push(structuredClone(value.health))});
  assert.deepEqual(receipt.health.attempts.map(x=>x.status),[404,404,200]);
  assert(receipt.health.attempts.every((x,i)=>i===0 || x.offsetMs>receipt.health.attempts[i-1].offsetMs));
  assert.equal(receipt.health.attempts[0].cfRay,'ray-1');assert.equal(receipt.health.attempts[0].contentType,'text/plain');assert.equal(receipt.health.attempts[0].body,undefined);
  assert.equal(sleeps.length,2);assert(sleeps.every(ms=>ms>0));assert.deepEqual(snapshots.at(-1),receipt.health);assert.equal(receipt.health.ok,true);
});
readinessCase('persistent 503 exhausts total bound and retains final status and all attempts',async t=>{
  const {fixture,args,sleeps}=setup(t);const bound=5000,body='x'.repeat(1024);fixture.state.healthOverride=()=>new Response(body,{status:503});
  let persisted,error0;await assert.rejects(deploy({...args,readiness:{...args.readiness,totalMs:bound},onHealth:async value=>persisted=structuredClone(value)}),error=>{
    error0=error;assert.match(error.message,/last-status-503/);assert(error.attempts.length>1);assert(error.attempts.every(x=>x.status===503));assert.equal(error.receipt.health.ok,false);return true;
  });
  assert.equal(sleeps.reduce((a,b)=>a+b,0),bound);assert.equal(persisted.health.attempts.length,sleeps.length);assert(persisted.health.attempts.every(x=>x.offsetMs<bound));assert(persisted.health.attempts.every(x=>x.body===undefined));assert(error0.attempts[0].body.length<body.length);assert(body.startsWith(error0.attempts[0].body));
});
for (const [title,response,pattern] of [
  ['302',()=>new Response('redirect',{status:302,headers:{location:'https://elsewhere.invalid'}}),/last-status-302/],
  ['wrong identity',()=>Response.json({ok:true,deployment:{sourceSha:'old'}}),/health-identity/],
  ['malformed',()=>new Response('not json'),/malformed/],
  ['unhealthy',()=>Response.json({ok:false}),/health-identity/],
]) readinessCase(`${title} fails at once`,async t=>{
  const {fixture,args,sleeps}=setup(t);fixture.state.healthOverride=response;
  await assert.rejects(deploy(args),error=>{assert.match(error.message,pattern);assert.equal(error.attempts.length,1);return true;});assert.deepEqual(sleeps,[]);
});
readinessCase('transport and Cloudflare 52x are transient',async t=>{
  const {fixture,args}=setup(t);let calls=0;fixture.state.healthOverride=()=>{calls++;if(calls===1)throw new Error('must never emit transport diagnostics');if(calls===2)return new Response('edge',{status:522});return Response.json({ok:true,deployment:{sourceSha:args.artifact.source.sha,fingerprint:fixture.state.settings.bindings.find(x=>x.name==='RER_DEPLOY_FINGERPRINT').text,versionId:fixture.state.version.id}});};
  const receipt=await deploy(args);assert.deepEqual(receipt.health.attempts.map(x=>x.status),[null,522,200]);assert.equal(receipt.health.attempts[0].errorClass,'health-transport-failed');
});

readinessCase('an unchanged repeat makes one health request and records no attempts',async t=>{
  const {fixture,args}=setup(t);const first=await deploy(args);let calls=0;const inner=fixture.fetch;
  const fetch=(url,init)=>{if(new URL(url).hostname.endsWith('.workers.dev'))calls++;return inner(url,init);};
  const again=await deploy({...args,fetch,previousReceipt:first,repeatOnly:true});
  assert.equal(again.changed,false);assert.equal(calls,1);assert.equal(again.health,undefined);
});

test('deployment readiness records bounded transient recovery and terminal failures', async () => {
  for (const {name,run} of readinessCaseRows) await runCase(name,run);
});
