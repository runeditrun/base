import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signinCommand } from '../../../cli/signin.mjs';
import { main, report } from '../owner-cli.mjs';
import { cloudflare } from '../provider.mjs';
import { ownerProvider } from './owner-provider.mjs';

async function setup(t, workersSettings = {free_tier:false}) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'rer-worker-settings-')));
  t.after(() => rm(root,{recursive:true,force:true}));
  for (const path of ['dist/server','dist/client','migrations/core']) await mkdir(join(root,path),{recursive:true});
  const build = async (limits) => {
    await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({
      main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],limits,
    }));
    await writeFile(join(root,'dist/server/index.js'),'export default {fetch(){return new Response("hello")}};');
  };
  await build();
  const declaration = 'deploy.json';
  await writeFile(join(root,declaration),JSON.stringify({version:1,project:'tests/settings',compatibilityDate:'2026-09-08',
    d1:[{binding:'DB'}],secrets:[{binding:'MAIL_KEY',environment:'MAIL_KEY'}]}));
  await writeFile(join(root,'migrations/core/0001_auth.sql'),`
    CREATE TABLE oa_operators (id TEXT, version INTEGER, email TEXT, role TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE oa_bootstrap (claim_id TEXT);
    CREATE TABLE oa_owner_signins (id TEXT, token_hash TEXT, operator_id TEXT, operator_version INTEGER, created_at INTEGER, expires_at INTEGER);
  `);
  await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');
  const git = (...args) => execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false',...args],{cwd:root,stdio:'pipe'});
  git('init','-q'); git('add','.'); git('commit','-qm','Seed fixture');
  const provider = ownerProvider({workersSettings}); t.after(() => provider.close());
  const {state,fetch,token,accountId} = provider, api = cloudflare(provider), worker = 'settings-production';
  const creds = {CLOUDFLARE_ACCOUNT_ID:accountId,CLOUDFLARE_API_TOKEN:token};
  const notices = [];
  const args = ['--declaration',declaration,'--environment','production'];
  const run = (command = 'deploy') => main([command,...args],{...creds,MAIL_KEY:'test-only-mail-key'},
    {cwd:root,fetch,notice:line => notices.push(line)});
  const offline = () => main(['local-plan',...args],{},{cwd:root,fetch:() => assert.fail('offline plan contacted Cloudflare')});
  const statePath = join(root,'.rer/deploy/production.json');
  const record = async () => JSON.parse(await readFile(statePath,'utf8'));
  await run();
  state.databases[0].db.exec("INSERT INTO oa_operators VALUES ('owner', 1, 'owner@example.test', 'owner', 'active', 1)");
  const project = {root,profile:'first-party',adapter:{deploy:Object.assign(async () => {},{declaration})}};
  const signin = async lines => {
    const previous = Object.fromEntries(Object.keys(creds).map(key => [key,process.env[key]]));
    Object.assign(process.env,creds);
    try { return await signinCommand(project,{environment:'production'},{human:line => lines.push(line)},{fetch}); }
    finally { for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };
  const patch = body => api.request(`/workers/scripts/${worker}/settings`,{method:'PATCH',body});
  const settings = () => api.request(`/workers/scripts/${worker}/settings`);
  return {state,api,worker,build,run,record,statePath,notices,patch,settings,signin,offline,fail:provider.fail};
}

test('Workers Paid deploys and redeploys Wrangler limits and keeps them when it adopts a settings-only version',async t => {
  const f = await setup(t);
  const initial = (await f.record()).receipt.provider;
  const limits = {cpu_ms:30000,subrequests:150};
  await f.patch({limits});
  // Cloudflare can change the script ETag along with the settings version.
  f.state.version.resources.script.etag = 'settings-version-etag';
  const lines = [];
  assert.equal((await f.signin(lines)).owner,'owner@example.test');
  assert.equal(lines.length,2);
  assert.equal(f.state.databases[0].db.prepare('SELECT count(*) AS count FROM oa_owner_signins').get().count,1);
  const signed = await f.record();
  assert.deepEqual(signed.settingsAdoption.previous,initial);
  assert.deepEqual(signed.settingsAdoption.provider,signed.receipt.provider);
  assert.equal(signed.receipt.provider.versionId,f.state.version.id);
  assert.equal(signed.receipt.provider.deploymentId,f.state.deployments[0].id);

  await f.patch({limits:{cpu_ms:45000}});
  const adjusted = f.state.version.id;
  const checked = await f.run();
  assert.equal(checked.changed,false);
  assert.equal(checked.versionId,adjusted);
  assert.equal((await f.record()).receipt.provider.versionId,adjusted);

  await f.build(limits);
  const upgraded = await f.run();
  assert.equal(upgraded.changed,true);
  const checkSettings = async () => {
    const {usage_model, limits:reportedLimits} = await f.settings();
    assert.deepEqual({usage_model,limits:reportedLimits},{usage_model:'standard',limits});
  };
  await checkSettings();
  assert.deepEqual((await f.record()).receipt.config.limits,limits);
  assert.equal((await f.record()).settingsAdoption.provider.versionId,adjusted);

  await f.patch({compatibility_flags:['nodejs_compat']});
  const matchingVersion = f.state.version.id;
  const adopted = await f.run();
  assert.equal(adopted.changed,false);
  assert.equal(adopted.versionId,matchingVersion);
  assert.deepEqual((await f.record()).receipt.config.limits,limits);
  await checkSettings();

  await f.patch({limits:{...limits,cpu_ms:45000}});
  f.fail('PUT',/^\/workers\/scripts\/settings-production$/,{afterApply:true});
  await assert.rejects(f.run());
  const uploaded = f.state.version.id;
  await checkSettings();
  assert.equal((await f.run()).versionId,uploaded,'the retry adopts the completed upload');
  await checkSettings();
  assert.equal((await f.run()).changed,false);
});

test('Workers Free omits the CPU override and an unreadable or ambiguous plan stops deployment',async t => {
  const workersSettings = {free_tier:null};
  const f = await setup(t,workersSettings);
  const limits = {cpu_ms:12_345};
  await f.build(limits);
  assert.deepEqual((await f.offline()).plan.workersPaidLimits,limits);

  const writes = f.state.writes.length;
  f.fail('GET',/^\/workers\/settings$/,{status:403});
  for (const message of [/Workers settings could not be read.*account and API token/,/Workers settings did not identify the account plan/]) {
    await assert.rejects(f.run(),error => {
      assert.match(report(error).message,message);
      return true;
    });
    assert.equal(f.state.writes.length,writes,'limits lookup stopped all provider writes');
  }
  workersSettings.free_tier = true;
  const preview = await f.run('dry-run');
  assert.equal(preview.deployed,false);
  assert.equal(Object.hasOwn(preview,'limits'),false);
  assert.equal(f.state.writes.length,writes);
  await f.run();
  assert.equal(Object.hasOwn(await f.settings(),'limits'),false);

  workersSettings.free_tier = false;
  assert.equal((await f.run()).changed,true,'an account upgrade applies the limit with the same source');
  const paid = await f.settings();
  assert.deepEqual(paid.limits,limits);
  assert.equal(paid.usage_model,'standard');
  assert.equal((await f.run()).changed,false);
});

test('settings adoption refuses changed code, changed bindings, missing marks and a secret rotation before writes',async t => {
  for (const change of ['script','binding','unmarked','secret rotation','intervening rotation']) await t.test(change,async t => {
    const f = await setup(t);
    const limits = {cpu_ms:30000};
    if (change === 'secret rotation' || change === 'intervening rotation') {
      await f.api.request(`/workers/scripts/${f.worker}/secrets`,{method:'PUT',body:{name:'MAIL_KEY',type:'secret_text',text:'test-only-rotated-key'}});
      if (change === 'intervening rotation') await f.patch({limits});
    } else {
      const bindings = f.state.settings.bindings.flatMap(row => {
        if (change === 'binding' && row.name === 'DB') return [{...row,id:'foreign-database'}];
        if (change === 'unmarked' && row.name === 'RER_DEPLOY_FINGERPRINT') return [];
        return [row];
      });
      await f.patch({limits,bindings});
      if (change === 'script') {
        const version = f.state.version;
        version.resources.script.etag = 'replacement-script-etag';
        const content = f.state.content.get(version.id);
        f.state.content.set(version.id,{...content,files:content.files.map(file => ({...file,bytes:Buffer.from('replacement')}))});
      }
    }
    const bytes = await readFile(f.statePath), calls = f.state.calls.length;
    await assert.rejects(f.run(),{message:'owned-resource-replaced'});
    await assert.rejects(f.signin([]),/owned-resource-replaced/);
    assert.ok(f.state.calls.slice(calls).every(call => call.method === 'GET'));
    assert.deepEqual(await readFile(f.statePath),bytes);
  });
});
