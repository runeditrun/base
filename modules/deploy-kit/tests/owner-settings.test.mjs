import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signinCommand } from '../../../cli/signin.mjs';
import { main } from '../owner-cli.mjs';
import { cloudflare } from '../provider.mjs';
import { ownerProvider } from './owner-provider.mjs';

async function setup(t) {
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
  const provider = ownerProvider(); t.after(() => provider.close());
  const {state,fetch,token,accountId} = provider, api = cloudflare(provider), worker = 'settings-production';
  const creds = {CLOUDFLARE_ACCOUNT_ID:accountId,CLOUDFLARE_API_TOKEN:token};
  const notices = [];
  const run = () => main(['deploy','--declaration',declaration,'--environment','production'],{...creds,MAIL_KEY:'test-only-mail-key'},
    {cwd:root,fetch,notice:line => notices.push(line)});
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
  return {state,api,worker,build,run,record,statePath,notices,patch,signin};
}

test('signin and deploy record an authenticated settings change and deploy sends the built Wrangler limits',async t => {
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
  assert.deepEqual(f.state.version.resources.script_runtime.limits,limits);
  assert.deepEqual((await f.record()).receipt.config.limits,limits);
  assert.equal((await f.record()).settingsAdoption.provider.versionId,adjusted);

  await f.patch({limits:{...limits,cpu_ms:45000}});
  assert.equal((await f.run()).changed,true);
  assert.deepEqual(f.state.version.resources.script_runtime.limits,limits);
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
