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

test('owner CLI reports refusal codes and resource names, never other error text', () => {
  const collision = Object.assign(new Error('resource-name-collision'),{resource:'d1:vector-production-db'});
  assert.deepEqual(report(collision),{ok:false,code:'resource-name-collision',resource:'d1:vector-production-db'});
  assert.deepEqual(report(new Error('missing-secret-SESSION_SECRET')),{ok:false,code:'missing-secret-SESSION_SECRET'});
  assert.deepEqual(report(new Error('Unexpected token test-only-session-value in JSON')),{ok:false,code:'owner-deploy-failed'});
  assert.deepEqual(report(Object.assign(new Error('missing-input'),{inputs:['CLOUDFLARE_API_TOKEN']})),{ok:false,code:'missing-input',inputs:['CLOUDFLARE_API_TOKEN']});
});
