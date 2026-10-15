import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, report } from '../owner-cli.mjs';
import { ownerProvider } from './owner-provider.mjs';

const declaration = {version:1,project:'runeditrun/vector',compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],
  d1:[{binding:'DB'}],r2:[{binding:'FILES'}],secrets:[{binding:'SESSION_SECRET',environment:'SESSION_SECRET'}],crons:['* * * * *'],
  vars:{SEED_SAMPLE_DATA:'false'},originVar:'APP_ORIGIN'};

/** A committed root-product seed with an existing local Vite-shaped build. */
async function seed(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'deploy-kit-owner-cli-'))); t.after(() => rm(root,{recursive:true,force:true}));
  for (const dir of ['dist/server','dist/client','migrations/core']) await mkdir(join(root,dir),{recursive:true});
  await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
  await writeFile(join(root,'dist/server/index.js'),'export default {scheduled() {},fetch(){return new Response("vector")}};');
  await writeFile(join(root,'dist/client/index.html'),'<h1>Vector</h1>');
  await writeFile(join(root,'migrations/core/0001_projects.sql'),'CREATE TABLE projects(id TEXT PRIMARY KEY);');
  await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
  await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');
  const git = (...args) => execFileSync('git',['-c','user.email=owner@example.test','-c','user.name=Owner','-c','commit.gpgsign=false',...args],{cwd:root,stdio:'pipe'});
  git('init','-q'); git('add','.'); git('commit','-qm','seed');
  return root;
}
function inputs(provider, extra = {}) { return {CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token,SESSION_SECRET:'test-only-session-value',...extra}; }

test('owner CLI deploys with only the owner token and account id, then re-runs and checks health without writes', async t => {
  const provider = ownerProvider(); t.after(() => provider.close());
  const root = await seed(t);
  const notices = [], options = {fetch:provider.fetch,cwd:root,notice:line => notices.push(line)};
  const argv = ['deploy','--declaration','deploy.json','--environment','production'];
  const first = await main(argv,inputs(provider),options);
  assert.deepEqual({...first,versionId:undefined},{ok:true,changed:true,worker:'vector-production',origin:'https://vector-production.fixture-account.workers.dev',versionId:undefined,
    created:['d1:vector-production-db','r2:vector-production-files'],sentSecrets:['SESSION_SECRET'],retiredSecrets:[],state:join(root,'.rer/deploy/production.json')});
  assert.equal(provider.state.databases[0].db.prepare("SELECT name FROM sqlite_master WHERE name='projects'").get().name,'projects');
  const writes = provider.state.writes.length, bytes = await readFile(first.state);
  const second = await main(argv,inputs(provider),options);
  assert.equal(second.changed,false); assert.deepEqual(second.created,[]);
  assert.equal(notices.length,2,'each deploy of a Cron Worker says once that the first scheduled run can take hours');
  assert.deepEqual(await main(['health','--declaration','deploy.json','--environment','production'],inputs(provider),options),{ok:true,worker:'vector-production',origin:first.origin});
  // An edge still answering from the previous version (as after a secret change) settles within the bound.
  let answers = 0;
  provider.state.healthOverride = () => {
    const vars = Object.fromEntries(provider.state.settings.bindings.filter(x => x.type === 'plain_text').map(x => [x.name,x.text]));
    return Response.json({ok:true,deployment:{sourceSha:vars.RER_DEPLOY_SOURCE,fingerprint:vars.RER_DEPLOY_FINGERPRINT,versionId:answers++ ? provider.state.version.id : randomUUID()}});
  };
  assert.equal((await main(['health','--declaration','deploy.json','--environment','production'],inputs(provider),options)).ok,true);
  assert.equal(answers,2);
  assert.equal(provider.state.writes.length,writes);
  assert.deepEqual(await readFile(first.state),bytes);
});

test('owner CLI names only its two Cloudflare inputs and refuses uncommitted source before any provider write', async t => {
  const provider = ownerProvider(); t.after(() => provider.close());
  const root = await seed(t);
  const options = {fetch:provider.fetch,cwd:root};
  const argv = ['deploy','--declaration','deploy.json','--environment','production'];
  const throwaway = {CF_THROWAWAY_ACCOUNT_ID:provider.accountId,CF_THROWAWAY_API_TOKEN:provider.token,RER_DEPLOY_RUN_ID:'1'};
  await assert.rejects(main(argv,throwaway,options),error => error.message === 'missing-input' && JSON.stringify(error.inputs) === '["CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_API_TOKEN"]');
  await assert.rejects(main(['deploy','--environment','production'],inputs(provider),options),/usage/);
  await assert.rejects(main(argv,inputs(provider,{CLOUDFLARE_ACCOUNT_ID:'not-an-account'}),options),/invalid-cloudflare-input/);
  await writeFile(join(root,'migrations/core/0001_projects.sql'),'CREATE TABLE changed(id TEXT);');
  await assert.rejects(main(argv,inputs(provider),options),/owner-source-not-committed/);
  assert.equal(provider.state.writes.length,0);
  assert.equal(provider.state.calls.filter(x => x.method !== 'GET').length,0);
});

// Virtual time for the kit's list waits: no test sleeps.
function clock() { let now = 0; return {settle:{clock:() => now,sleep:async ms => { now += ms; }},elapsed:() => now}; }

test('a first deploy completes while the account lists its new D1 database up to two minutes late', async t => {
  for (const shape of ['count','omit']) {
    const provider = ownerProvider(); t.after(() => provider.close());
    const root = await seed(t), time = clock();
    const argv = ['deploy','--declaration','deploy.json','--environment','production'];
    provider.lagD1(28,shape);
    const first = await main(argv,inputs(provider),{fetch:provider.fetch,cwd:root,settle:time.settle,notice:() => {}});
    assert.deepEqual(first.created,['d1:vector-production-db','r2:vector-production-files'],shape);
    assert.ok(time.elapsed() > 60000,'the listing stayed behind for over a minute');
    assert.equal(provider.state.databases.length,1);
    assert.equal((await main(argv,inputs(provider),{fetch:provider.fetch,cwd:root,settle:time.settle,notice:() => {}})).changed,false);
  }
});

test('a D1 database the account never lists is named, kept in the saved state, and found by the next run', async t => {
  for (const shape of ['count','omit']) {
    const provider = ownerProvider(); t.after(() => provider.close());
    const root = await seed(t), time = clock();
    const argv = ['deploy','--declaration','deploy.json','--environment','production'];
    provider.lagD1(Infinity,shape);
    const failure = await main(argv,inputs(provider),{fetch:provider.fetch,cwd:root,settle:time.settle,notice:() => {}}).then(() => assert.fail('deployed'),error => error);
    const named = report(failure);
    assert.equal(named.code,'resource-not-listed',shape); assert.equal(named.resource,'d1:vector-production-db');
    assert.equal(provider.state.writes.some(write => write.path?.startsWith('/workers/scripts/')),false,'nothing was uploaded');
    provider.lagD1(0);
    const resumed = await main(argv,inputs(provider),{fetch:provider.fetch,cwd:root,settle:time.settle,notice:() => {}});
    assert.deepEqual(resumed.created,['r2:vector-production-files'],'the saved database is reused, not created again');
    assert.equal(provider.state.databases.length,1,'the database was not created twice');
  }
});

test('owner CLI reports refusal codes and resource names, never other error text', () => {
  const collision = Object.assign(new Error('resource-name-collision'),{resource:'d1:vector-production-db'});
  assert.deepEqual(report(collision),{ok:false,code:'resource-name-collision',resource:'d1:vector-production-db'});
  assert.deepEqual(report(new Error('missing-secret-SESSION_SECRET')),{ok:false,code:'missing-secret-SESSION_SECRET'});
  assert.deepEqual(report(new Error('Unexpected token test-only-session-value in JSON')),{ok:false,code:'owner-deploy-failed'});
  assert.deepEqual(report(Object.assign(new Error('missing-input'),{inputs:['CLOUDFLARE_API_TOKEN']})),{ok:false,code:'missing-input',inputs:['CLOUDFLARE_API_TOKEN']});
});

test('postdeploy readback waits only for fresh workers.dev 1042 within the upload deadline', async t => {
 const provider = ownerProvider(); t.after(() => provider.close());
 const root = await seed(t); let elapsed = 0, attempts = 0;
 const healthOptions = { now: () => elapsed, sleep: async ms => { elapsed += ms; } };
 const options = {fetch:provider.fetch,cwd:root,notice:()=>{},healthOptions};
 const args = ['--declaration','deploy.json','--environment','production'];
 const first = await main(['deploy',...args], inputs(provider), options);
 const healthy = () => {
  const vars = Object.fromEntries(provider.state.settings.bindings.filter(x => x.type === 'plain_text').map(x => [x.name,x.text]));
  return Response.json({ok:true,deployment:{sourceSha:vars.RER_DEPLOY_SOURCE,fingerprint:vars.RER_DEPLOY_FINGERPRINT,versionId:provider.state.version.id}});
 };
 provider.state.healthOverride = () => ++attempts === 1 ? new Response('error code: 1042', {status:404}) : healthy();
 assert.equal((await main(['health',...args], inputs(provider), {...options,propagation:first.propagation})).ok, true);
 assert.equal(attempts, 2); assert.equal(elapsed, 2000);
 for (const [name, response, fresh] of [
  ['established', () => new Response('error code: 1042', {status:404}), false],
  ['other 404', () => new Response('not found', {status:404}), true],
  ['truncated 1042 prefix', () => new Response('error code: 1042' + ' '.repeat(300) + 'unrelated error', {status:404}), true],
  ['authentication', () => new Response('error code: 1042', {status:403}), true],
  ['redirect', () => new Response(null, {status:302,headers:{location:'https://elsewhere.invalid/health'}}), true],
  ['malformed', () => new Response('not json', {status:200}), true],
 ]) {
  attempts = 0;
  provider.state.healthOverride = () => { attempts++; return response(); };
  await assert.rejects(main(['health',...args], inputs(provider), {...options,...(fresh ? {propagation:first.propagation} : {})}), undefined, name);
  assert.equal(attempts, 1, name);
 }
 elapsed = 89000; attempts = 0;
 provider.state.healthOverride = () => { attempts++; return new Response('error code: 1042', {status:404}); };
 await assert.rejects(main(['health',...args], inputs(provider), {...options,propagation:first.propagation}), /last-status-404/);
 assert.equal(attempts, 1, 'no probe starts after the original upload deadline');
 assert.equal(elapsed, 90000, 'postdeploy readback cannot add a new 30-second window');
 // The same deadline also aborts a provider response, not just the next poll.
 const slow = ownerProvider(); t.after(() => slow.close());
 const slowRoot = await seed(t); let uploaded = false, aborted = false, reads = 0;
 const fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (uploaded && url.pathname.endsWith('/settings')) {
   reads++;
   await new Promise((resolve, reject) => {
    const abort = () => { aborted = true; reject(init.signal.reason); };
    if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, {once:true});
   });
  }
  const result = await slow.fetch(input, init);
  if (init.method === 'PUT' && url.searchParams.get('bindings_inherit') === 'strict') uploaded = true;
  return result;
 };
 // Keep the test process alive while the production timeout (an unref timer) fires.
 const hold = setTimeout(() => {}, 1000);
 try { await assert.rejects(main(['deploy',...args], inputs(slow), {cwd:slowRoot,fetch,notice:()=>{},healthOptions:{readiness:{totalMs:50}}}), /provider-transport-failed/); }
 finally { clearTimeout(hold); }
 assert.ok(aborted); assert.equal(reads, 1, 'an expired provider read is not retried');

});
