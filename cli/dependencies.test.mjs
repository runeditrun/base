import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,cp,access,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {owner} from '../onboarding/adapter-auth.mjs';
import {linkDependencies} from './dependencies.mjs';
import {exportCLI} from './export.mjs';
import {runtime,ORIGIN,ISSUER} from '../modules/dependencies/tests/runtime.mjs';

async function tokenFixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-link-token-')));t.after(()=>rm(root,{recursive:true,force:true}));execFileSync('git',['init','--quiet',root]);
 const r=await runtime(t);const contract='oidc-provider@1',callbacks=[ORIGIN+'/.well-known/rer-link/callback',ORIGIN+'/auth/oidc/auth/callback',ORIGIN+'/auth/oidc/auth/logout'];
 const project={root,setupManifest:{dependencies:[{interface:contract,optional:true,cardinality:1,address:'IDENTITY_PROVIDER',paths:['/auth/oidc/auth/callback','/auth/oidc/auth/logout']}]}};
 const token={token:crypto.randomUUID(),interface:contract,issuer:ISSUER,origin:ORIGIN,callbacks,issuedAt:r.now(),expiresAt:r.now()+3600000};r.tokens.set(token.token,token);
 const path=join(root,'link.json');await writeFile(path,JSON.stringify(token),{mode:0o600});const previous=process.env.RER_LINK_TOKEN_FILE;process.env.RER_LINK_TOKEN_FILE='link.json';t.after(()=>{if(previous===undefined)delete process.env.RER_LINK_TOKEN_FILE;else process.env.RER_LINK_TOKEN_FILE=previous;});
 const logs=[],store={report:m=>logs.push(m),addSecrets:()=>{},step:async()=>{}};
 const original=globalThis.fetch;globalThis.fetch=r.fetch;
 try{await owner({manifest:project.setupManifest,input:{IDENTITY_PROVIDER:ISSUER},vars:r.config,origin:ORIGIN,store},{});}finally{globalThis.fetch=original;}
 assert.equal(r.sqlite.prepare('SELECT first_setup FROM oa_auth_settings').get().first_setup,1);
 assert.equal(r.sqlite.prepare('SELECT count(*) n FROM rer_dependency_pending').get().n,1);
 return {root,r,token,path,project,logs,run:()=>linkDependencies({project,input:{IDENTITY_PROVIDER:ISSUER},origin:ORIGIN,store,fetch:r.fetch,clock:r.now})};
}
test('CLI link uses a private one-time exact-origin approval, removes it on success, and refuses reuse, expiry, wrong origins/callbacks and tracked credentials',async t=>{
 const f=await tokenFixture(t);const {r,token,path}=f;
 for(const patch of [{origin:'https://elsewhere.example'},{callbacks:[ORIGIN+'/other']},{expiresAt:r.now()-1},{issuedAt:r.now()-3600001}]){await writeFile(path,JSON.stringify({...token,...patch}));await assert.rejects(f.run(),e=>e.exitCode===3||e.status===3);}
 await writeFile(path,JSON.stringify(token));execFileSync('git',['-C',f.root,'add','link.json']);await assert.rejects(f.run(),e=>e.exitCode===2||e.status===2);execFileSync('git',['-C',f.root,'rm','--cached','link.json']);
 await f.run();assert.equal(r.sqlite.prepare('SELECT idp_sign_in FROM oa_auth_settings').get().idp_sign_in,1);await assert.rejects(access(path));assert.equal(f.logs.join('').includes(token.token),false);
 await writeFile(path,JSON.stringify(token),{mode:0o600});await assert.rejects(f.run());
 // Hosted preclaim linking requires the app's setup secret in addition to the
 // provider token. Both use real HTTP handlers; only the issuer is controlled.
 const hosted=await runtime(t),store={report:()=>{},addSecrets:()=>{}};
 const runHosted=appSetupToken=>linkDependencies({project:f.project,input:{IDENTITY_PROVIDER:ISSUER},origin:ORIGIN,store,fetch:hosted.fetch,clock:hosted.now,appSetupToken});
 async function freshToken(){const value={...token,used:false,token:crypto.randomUUID()};hosted.tokens.set(value.token,value);await writeFile(path,JSON.stringify(value),{mode:0o600});}
 await freshToken();await assert.rejects(runHosted());assert.equal(hosted.sqlite.prepare('SELECT count(*) n FROM rer_dependency_link').get().n,0);
 await freshToken();await runHosted(hosted.config.SETUP_TOKEN);assert.equal(hosted.sqlite.prepare('SELECT count(*) n FROM rer_dependency_link').get().n,1);
 await hosted.bootstrap({approve:false});assert.equal(hosted.sqlite.prepare('SELECT first_setup FROM oa_auth_settings').get().first_setup,0);

});
test('public rer setup refuses a selected transitive optional cycle before settings or owner writes, with exit 2; missing approval is exit 3',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-graph-cli-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const base=join(import.meta.dirname,'..');await cp(join(base,'default-seed'),root,{recursive:true,filter:p=>!p.split('/').some(n=>['node_modules','.wrangler','.seed','.rer','dist','.cache','base-cli','base-onboarding'].includes(n))});
 await exportCLI(base,root);await cp(join(base,'onboarding'),join(root,'scripts/base-onboarding'),{recursive:true,filter:p=>!p.endsWith('.test.mjs')});
 const fixture=join(root,'network.mjs');
 await writeFile(fixture,`globalThis.fetch=async value=>{const origin=new URL(value).origin;const next={'https://one.example':'https://two.example','https://two.example':'https://three.example','https://three.example':'https://one.example'}[origin];return Response.json({origin,version:1,provides:['oidc-provider@1'],dependencies:process.env.FIXTURE_ACYCLIC?[]:[{interface:'oidc-provider@1',optional:true,cardinality:1,provider:next}]});};`);
 await writeFile(join(root,'answers.json'),JSON.stringify({OWNER_EMAIL:'owner@example.com',IDENTITY_PROVIDER:'https://one.example'}),{mode:0o600});
 const args=['--import',fixture,'scripts/rer.mjs','setup','--answers','answers.json','--non-interactive','--json','--no-queue','--port','4317'];
 // The original caller is CI here; a verify run's own queue policy must not leak in.
 const caller={...process.env};delete caller.RER_JOB_POLICY;delete caller.RER_JOB_MEMBERSHIP;
 const run=env=>spawnSync(process.execPath,args,{cwd:root,env:{...caller,CI:'true',RER_LINK_TOKEN_FILE:'',...env},encoding:'utf8',timeout:30000});
 const cycle=run({});assert.equal(cycle.status,2,cycle.stdout+cycle.stderr);await assert.rejects(access(join(root,'.dev.vars')));
 const missing=run({FIXTURE_ACYCLIC:'1'});assert.equal(missing.status,3,missing.stdout+missing.stderr);await assert.rejects(access(join(root,'.dev.vars')));
 execFileSync('git',['init','--quiet',root]);
 const origin='http://127.0.0.1:4317',issuedAt=Date.now(),approval={token:crypto.randomUUID(),issuer:'https://one.example',interface:'oidc-provider@1',origin,callbacks:[origin+'/.well-known/rer-link/callback',origin+'/auth/oidc/auth/callback',origin+'/auth/oidc/auth/logout'],issuedAt,expiresAt:issuedAt+3600000};
 for(const patch of [{origin:'https://wrong.example'},{callbacks:[origin+'/elsewhere']},{expiresAt:Date.now()-1}]) {
  await writeFile(join(root,'approval.json'),JSON.stringify({...approval,...patch}),{mode:0o600});
  const refused=run({FIXTURE_ACYCLIC:'1',RER_LINK_TOKEN_FILE:'approval.json'});assert.equal(refused.status,3,refused.stdout+refused.stderr);await assert.rejects(access(join(root,'.dev.vars')));
 }
 await writeFile(join(root,'approval.json'),JSON.stringify(approval),{mode:0o600});execFileSync('git',['-C',root,'add','approval.json']);
 const tracked=run({FIXTURE_ACYCLIC:'1',RER_LINK_TOKEN_FILE:'approval.json'});assert.equal(tracked.status,2,tracked.stdout+tracked.stderr);await assert.rejects(access(join(root,'.dev.vars')));
});
