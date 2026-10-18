import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {linkedDeploy} from './fixtures/dependency-deploy.mjs';
import {linkedBrowser} from './fixtures/dependency-browser.mjs';
import {linkedSetup} from './fixtures/dependency-link.mjs';

// One journey per concern, each set up once from a fresh seed so that no single
// test nears its limit on a slow runner: link and browse, restore, deploy.
const kinds=['default-seed','foundation'],limit={timeout:300000},owner='cli-owner@example.test';
const timed=(t,kind,f)=>{const begun=Date.now();t.after(()=>t.diagnostic(`${kind} ${Math.round((Date.now()-begun)/1000)}s after fixture; ${f.timingSummary()}`));};
const bare={RER_LINK_TOKEN_FILE:'',RER_LINK_TOKEN_FILES:''};

for(const kind of kinds)test(`${kind}: public noninteractive setup links Auth after native owner, repeats without a token and keeps private approval out of saved answers`,limit,async t=>{
 const {f,origin,provider,approvals,approvalFiles,used,state,edge,env,args,writeApprovals}=await linkedSetup(kind,t);timed(t,kind,f);
 await writeApprovals();const reused=f.launch(args,process.execPath,env);assert.equal(await reused.done,3,'reused setup command has the expected outcome');for(const file of Object.values(approvalFiles))await unlink(join(f.root,file));
 const second=f.launch(args,process.execPath,{...env,...bare});assert.equal(await second.done,0,'second setup command has the expected outcome');
 if(kind==='default-seed') {const value=approvals.get('error-sink@1');value.token=crypto.randomUUID();used.delete('error-sink@1');await writeFile(join(f.root,approvalFiles['error-sink@1']),JSON.stringify(value),{mode:0o600});const partial=f.launch(args,process.execPath,{...env,RER_LINK_TOKEN_FILES:JSON.stringify({'error-sink@1':approvalFiles['error-sink@1']})});assert.equal(await partial.done,0,'partial setup command has the expected outcome');await assert.rejects(access(join(f.root,approvalFiles['error-sink@1'])));}
// Each checkpoint reads the seed's local D1 store in place; a wrangler launch costs seconds on CI.
 const [people,enabled]=await f.sql('SELECT email FROM oa_operators; SELECT idp_sign_in FROM oa_auth_settings');assert.deepEqual(people.results,[{email:'cli-owner@example.test'}]);assert.equal(enabled.results[0].idp_sign_in,1);
 await linkedBrowser(f,origin,provider,{...env,...bare},kind,{setUnavailable(value){state.unavailable=value;}});
 const beforeDry=edge.length,dry=f.launch(['scripts/rer.mjs','deploy','--dry-run','--json','--no-queue'],process.execPath,{...env,...bare});assert.equal(await dry.done,3,'deploy dry-run refuses without target credentials');assert.match(dry.stdoutText,/cannot read the target secret bindings/);assert.equal(edge.length,beforeDry);
 state.offline=true;const doctor=f.launch(['scripts/rer.mjs','doctor','--json'],process.execPath,{...env,...bare});assert.equal(await doctor.done,3);assert.ok(JSON.parse(doctor.stdoutText.trim().split('\n').at(-1)).diagnostics.dependencies.some(d=>d.status==='dangling_provider'));state.offline=false;
});

for(const kind of kinds)test(`${kind}: a linked seed exports, resets and imports to a relink prompt and relinks to the same sector`,limit,async t=>{
 const {f,approvals,used,env,args,writeApprovals}=await linkedSetup(kind,t);timed(t,kind,f);
 await f.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('member-fixture','cli-member@example.test','Member','member','active',2)");
 const [sector,bindings,originalPeople]=(await f.sql('SELECT sector_id FROM rer_dependency_installation; SELECT * FROM oa_external_identities ORDER BY issuer,subject; SELECT id,email FROM oa_operators ORDER BY id')).map(result=>result.results);
 const originalOwner=originalPeople.find(row=>row.email===owner);
 // Foundation retains people; a default-seed hosting move claims a fresh owner.
 const restoredBindings=kind==='foundation'?bindings:[];
 await f.run(['export','--output','exports/linked.rer','--json','--no-queue']);await f.run(['reset','--yes','--json']);
 const restored=await f.run(['import','--input','exports/linked.rer','--yes','--json','--no-queue']);assert.equal(JSON.parse(restored.stdoutText.trim().split('\n').at(-1)).needsRelink,true);
 const [importedSector,importedBindings,importedPeople,importedKeys,importedEnablement]=(await f.sql('SELECT sector_id FROM rer_dependency_installation; SELECT * FROM oa_external_identities ORDER BY issuer,subject; SELECT id,email FROM oa_operators ORDER BY id; SELECT count(*) n FROM rer_dependency_keys; SELECT count(*) n FROM oa_auth_settings WHERE idp_sign_in!=0 OR first_setup!=0')).map(result=>result.results);
 assert.deepEqual(importedSector,sector);assert.deepEqual(importedBindings,restoredBindings);
 assert.deepEqual(importedPeople,kind==='foundation'?originalPeople:[]);
 assert.equal(importedKeys[0].n,0);
 assert.equal(importedEnablement[0].n,0,'import restores no provider enablement');
 used.clear();for(const value of approvals.values())value.token=crypto.randomUUID();await writeApprovals();
 const relink=f.launch(args,process.execPath,env);assert.equal(await relink.done,0,'relink setup command has the expected outcome');
 const [relinkedSector,relinkedBindings,relinkedPeople,relinkedSetting]=(await f.sql('SELECT sector_id FROM rer_dependency_installation; SELECT * FROM oa_external_identities ORDER BY issuer,subject; SELECT id,email FROM oa_operators ORDER BY id; SELECT idp_sign_in FROM oa_auth_settings')).map(result=>result.results);
 assert.deepEqual(relinkedSector,sector);assert.deepEqual(relinkedBindings,restoredBindings);
 if(kind==='foundation')assert.deepEqual(relinkedPeople,originalPeople);
 else {
  assert.deepEqual(relinkedPeople.map(row=>({email:row.email})),[{email:owner}]);
  assert.notEqual(relinkedPeople[0].id,originalOwner.id,'a hosting move claims a fresh local identity');
 }
 assert.equal(relinkedSetting[0].idp_sign_in,kind==='default-seed'?1:0,'only a fresh owner’s explicit first-setup provider choice enables sign-in');
});

test('default-seed: a linked seed deploys to a controlled account and links Auth there',limit,async t=>{
 const {f,origin}=await linkedSetup('default-seed',t);timed(t,'default-seed',f);
 await linkedDeploy(t,f,origin);
});
