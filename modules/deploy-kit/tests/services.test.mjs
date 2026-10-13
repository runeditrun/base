import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare, ownerTarget, ownerPlan, ownerDeploy, ownerHealth } from '../index.mjs';
import { hash } from '../validation.mjs';
import { ownerProvider } from './owner-provider.mjs';

const source = 'export default {fetch(){return new Response(null,{status:404})}}';
const artifact = {version:1,source:{sha:'7'.repeat(40),tree:'8'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',
  modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],assets:[],migrations:[]};
const egress = {version:1,project:'runeditrun/egress-service',compatibilityDate:'2026-09-08',workersDev:false};
const consumer = {version:1,project:'just-every/penny',compatibilityDate:'2026-09-08',secrets:[],vars:{},
  services:[{binding:'PENNY_EGRESS',project:'runeditrun/egress-service',allowedHosts:['hooks.example.com','*.example.org']}]};

/** The shared fixture serves one Worker; the bound service Worker's presence is set here. */
async function account(t, project, {serviceWorker}) {
  const provider = ownerProvider(); t.after(() => provider.close());
  const dir = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-services-'))); t.after(() => rm(dir,{recursive:true,force:true}));
  const route = `/client/v4/accounts/${provider.accountId}/workers/scripts/egress-service-production/settings`;
  const routes = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input); routes.push(url.hostname);
    if (serviceWorker !== undefined && url.pathname.startsWith(route.slice(0, -'/settings'.length) + '/')) {
      if (!serviceWorker.present) return Response.json({success:false,errors:[{code:10007,message:'missing'}]},{status:404});
      let result;
      if (url.pathname === route) result = {bindings:serviceWorker.bindings ?? []};
      else if (url.pathname.endsWith('/deployments')) result = {deployments:[{id:serviceWorker.provider.deploymentId,versions:[{version_id:serviceWorker.provider.versionId,percentage:100}]}]};
      else if (url.pathname.endsWith('/versions/' + serviceWorker.provider.versionId)) result = {id:serviceWorker.provider.versionId,resources:{script:{etag:serviceWorker.provider.etag}}};
      else throw new Error('unexpected service request');
      return Response.json({success:true,errors:[],result});
    }
    return provider.fetch(input, init);
  };
  const api = cloudflare({...provider, fetch});
  const target = await ownerTarget(api,{project,environment:'production'});
  return {provider, api, target, routes, statePath:join(dir,'state.json'), fetch};
}

test('the egress Worker deploys without a public route and is checked by provider readback only', async t => {
  const {provider, api, target, routes, statePath, fetch} = await account(t, egress.project, {});
  provider.state.subdomain = true; // an earlier manual deploy left workers.dev on
  const plan = ownerPlan(target, egress, artifact);
  const {receipt} = await ownerDeploy({api, target, plan, artifact, statePath, fetch});
  assert.equal(target.worker, 'egress-service-production');
  assert.equal(receipt.origin, null);
  assert.equal(receipt.config.workers_dev, false);
  assert.equal(provider.state.subdomain, false, 'workers.dev is switched off');
  assert.deepEqual(receipt.health, {ok:true,versionId:receipt.provider.versionId,route:'none'});
  assert.ok(!routes.some(host => host.endsWith('.workers.dev')), 'no public request is made to the Worker');
  await ownerHealth({api, target, plan, statePath, fetch});
});

test('a consumer declares the service binding; deploy refuses until the service Worker exists', async t => {
  const serviceWorker = {present:false};
  const {provider, api, target, statePath, fetch} = await account(t, consumer.project, {serviceWorker});
  const plan = ownerPlan(target, consumer, artifact);
  assert.deepEqual(plan.services, [{binding:'PENNY_EGRESS',service:'egress-service-production',props:{allowedHosts:['hooks.example.com','*.example.org']}}]);
  await assert.rejects(ownerDeploy({api, target, plan, artifact, statePath, fetch}), error => error.message === 'service-worker-missing' && error.resource === 'service:egress-service-production');
  assert.deepEqual(provider.state.writes, [], 'refused before any provider write');
  serviceWorker.present = true;
  const {receipt} = await ownerDeploy({api, target, plan, artifact, statePath, fetch});
  const binding = {type:'service',name:'PENNY_EGRESS',service:'egress-service-production',props:{allowedHosts:['hooks.example.com','*.example.org']}};
  assert.deepEqual(provider.state.settings.bindings.find(x => x.type === 'service'), binding, 'uploaded and read back');
  assert.deepEqual(receipt.config.services, [{binding:'PENNY_EGRESS',service:'egress-service-production',props:{allowedHosts:['hooks.example.com','*.example.org']}}]);
  assert.equal(receipt.config.workers_dev, true);
  provider.state.settings.bindings = provider.state.settings.bindings.map(x => x.type === 'service' ? {...x,props:{allowedHosts:['*.com']}} : x);
  await assert.rejects(ownerHealth({api, target, plan, statePath, fetch}), /binding-readback-mismatch/, 'a widened destination grant is drift');
  for (const declaration of [
    {...consumer,services:[{binding:'PENNY_EGRESS',project:'runeditrun/egress-service',service:'chosen-name'}]},
    {...consumer,services:[{binding:'APP_ORIGIN',project:'runeditrun/egress-service'}],originVar:'APP_ORIGIN'},
    {...consumer,services:[{binding:'SELF',project:'just-every/penny'}]},
    {...consumer,services:[{binding:'E',project:'runeditrun/egress-service',allowedHosts:['https://hooks.example.com']}]},
    {...consumer,workersDev:true},
  ]) assert.throws(() => ownerPlan(target, declaration, artifact), /invalid-owner-declaration|invalid-service-binding|invalid-public-variable|duplicate-or-invalid-binding/);
});


test('a named service grant is tied to its deployment and rejects grant, provider and binding drift', async t => {
  const identity = {versionId:'11111111-1111-4111-8111-111111111111',deploymentId:'22222222-2222-4222-8222-222222222222',etag:'service-code-etag'};
  const grant = {allowedHosts:['hooks.example.com'],sourceSha:'9'.repeat(40),fingerprint:'a'.repeat(64),provider:identity};
  const serviceWorker = {present:true,provider:{...identity},bindings:[
    {name:'EGRESS_GRANTS',type:'plain_text',text:JSON.stringify([{entrypoint:'EgressRestricted',allowedHosts:grant.allowedHosts}])},
    {name:'RER_DEPLOY_SOURCE',type:'plain_text',text:grant.sourceSha},
    {name:'RER_DEPLOY_FINGERPRINT',type:'plain_text',text:grant.fingerprint},
  ]};
  const {provider, api, target, statePath, fetch} = await account(t, consumer.project, {serviceWorker});
  const plan = ownerPlan(target,{...consumer,services:[{binding:'PENNY_EGRESS',project:egress.project,entrypoint:'EgressRestricted',grant}]},artifact);
  await ownerDeploy({api,target,plan,artifact,statePath,fetch});
  const original = structuredClone(serviceWorker.bindings);
  for (const grants of [[],[{entrypoint:'EgressRestricted',allowedHosts:null}],
    [{entrypoint:'EgressRestricted',allowedHosts:grant.allowedHosts},{entrypoint:'EgressRestricted',allowedHosts:null}]]) {
    serviceWorker.bindings[0].text = JSON.stringify(grants);
    await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /service-grant-readback-mismatch/);
  }
  serviceWorker.bindings = original;
  serviceWorker.provider.etag = 'replacement';
  await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /service-grant-deployment-drift/);
  serviceWorker.provider.etag = identity.etag;
  const bound = provider.state.settings.bindings.find(x => x.type === 'service');
  bound.entrypoint = 'EgressService';
  await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /binding-readback-mismatch/);
  bound.entrypoint = 'EgressRestricted';
  bound.environment = 'other';
  await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /binding-readback-mismatch/);
  bound.environment = 'production'; // The provider's default is legitimate.
  const bindings = provider.state.settings.bindings;
  bindings.push({type:'secret_text',name:'OPERATOR_SECRET'}, {type:'plain_text',name:'OPERATOR_VAR',text:'present'});
  await ownerHealth({api,target,plan,statePath,fetch});
  for (const extra of [
    {...bound,name:'UNDECLARED_BROAD',entrypoint:'EgressService'},
    {...bound}, {type:'secret_text',name:'OPERATOR_SECRET'},
    {type:'service',service:'egress-service-production',entrypoint:'EgressService'},
  ]) {
    provider.state.settings.bindings = [...bindings,extra];
    await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /binding-readback-mismatch/);
  }
  provider.state.settings.bindings = bindings.filter(x => x !== bound);
  await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /binding-readback-mismatch/);
  provider.state.settings.bindings = bindings;
  bound.service = 'another-service-production';
  await assert.rejects(ownerHealth({api,target,plan,statePath,fetch}), /binding-readback-mismatch/);
});
