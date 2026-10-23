import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloudflare,ownerTarget,ownerPlan,ownerDeploy,ownerHealth,deploy} from '../index.mjs';
import {main,COMMANDS} from '../owner-cli.mjs';
import {hash} from '../validation.mjs';
import {renderConfig,verifyBindings} from '../render.mjs';
import {ownerProvider} from './owner-provider.mjs';
import {checkImageBindings,checkImageVariables} from '../../container/image-variables.mjs';
import {deployInputs} from '../../container/deploy-input.mjs';
import {validateCandidateSpec} from '../../delivery-producer/spec.mjs';
import {CONFIG_FAMILIES,AI_VARIABLES,AI_PRIVACY_TOKEN} from '../../ai/native/names.mjs';
import {canonical} from '../../ai/native/policy.mjs';
import {nativeBindings} from '../../demo-host/native/config.mjs';
import {uploadSecretCopy} from '../owner-secret-copy.mjs';
import {activeWorker} from '../worker.mjs';
const model='@cf/qwen/qwen3.8-27b';
const request={schema:1,provider:'cloudflare',transport:'native',binding:'AI',budgetBinding:'AI_BUDGET',imageBinding:'AI_IMAGES',textModels:[model],imageModels:[],purposes:[{id:'site-read',kind:'text',model}],limits:{calls:10,units:10000000,microUsd:10000000},operations:{textCalls:2,maxInputBytes:10000,maxOutputTokens:1024,imageUnits:0,timeoutMs:1000}};

test('owner-account deployment requires separate installation approval and reads back the native binding in the payer account',async t=>{
 const provider=ownerProvider();t.after(()=>provider.close());const api=cloudflare(provider);
 const target=await ownerTarget(api,{project:'synthetic',environment:'production'});
 const folder=await mkdtemp(join(tmpdir(),'native-ai-owner-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const source='export default { fetch(){ return new Response("ok") } }';
 const artifact={version:1,source:{sha:'5'.repeat(40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],assets:[],migrations:[]};
 const declaration={version:1,project:'synthetic',compatibilityDate:'2026-09-08',d1:[],r2:[{binding:'AI_IMAGES'}],queues:[],durableObjects:[{binding:'AI_BUDGET',className:'AiAuthority',storage:'sqlite'}],secrets:[{binding:'RER_AI_PRIVACY_TOKEN',environment:'RER_AI_PRIVACY_TOKEN'}],crons:[],vars:{},ai:request};
 assert.throws(()=>ownerPlan(target,declaration,artifact),e=>e.code==='ai_hosting_unproven');assert.equal(provider.state.writes.length,0);
 const authority={schema:1,enabled:true,accountId:provider.accountId,sourceSha:artifact.source.sha,installation:target.worker,environment:target.environment,tenant:'synthetic-tenant',revision:'initial',custody:'original',permitted:{...request,limits:{...request.limits,calls:2}},prices:{[model]:{version:'synthetic-prices',validUntil:Date.now()+86400000,inputMicroUsdPerMillion:450000,outputMicroUsdPerMillion:3200000,imageMicroUsdPerUnit:410}},proofs:{[model]:{reference:'synthetic-provider-edge',kind:'text',maxInputTokens:262144,maxOutputTokens:1024,maxImageUnits:0,mime:''}}};
 const env={RER_AI_AUTHORITY:JSON.stringify(authority),RER_AI_PRIVACY_TOKEN:'synthetic-private-custody-token-1'};
 const plan=ownerPlan(target,declaration,artifact,{env});
 assert.throws(()=>ownerPlan(target,{...declaration,vars:{RER_AI_ACCOUNT_ID:'untrusted'}},artifact,{env}),e=>e.code==='ai_policy_conflict');
 assert.throws(()=>ownerPlan(target,declaration,artifact,{env:{...env,RER_AI_AUTHORITY:JSON.stringify({...authority,installation:'other-installation'})}}),e=>e.code==='ai_policy_conflict');
 assert.throws(()=>renderConfig(plan,{d1:[],r2:[],queues:[]},'b'.repeat(32),'5'.repeat(40),'','index.js'),/ai-installation-account-mismatch/);
 const statePath=join(folder,'owner.json');
 const result=await ownerDeploy({api,target,plan,artifact,statePath,env,fetch:provider.fetch});assert.equal(result.receipt.changed,true);
 assert.ok(provider.state.settings.bindings.some(b=>b.type==='ai'&&b.name==='AI'));
 assert.equal(JSON.parse(provider.state.settings.bindings.find(b=>b.name==='RER_AI_AUTHORITY').text).permitted.limits.calls,2);
 assert.equal(provider.state.settings.bindings.find(b=>b.name==='RER_AI_ACCOUNT_ID').text,provider.accountId);
 assert.equal(provider.state.settings.bindings.find(b=>b.name==='RER_AI_BUCKET_NAME').text,'synthetic-production-ai-images');
 assert.ok(!String(await readFile(statePath)).includes(env.RER_AI_PRIVACY_TOKEN));
 assert.throws(()=>verifyBindings([{type:'ai',name:'OTHER'}],[{type:'ai',name:'AI'}]),/undeclared-native-ai-binding/);
 assert.throws(()=>verifyBindings([{type:'ai',name:'AI',account_id:'untrusted'}],[{type:'ai',name:'AI'}]),/binding-readback-mismatch/);
});

function deploymentInputs(target) {
 const source='export default { fetch(){ return new Response("ok") } }';
 const artifact={version:1,source:{sha:'5'.repeat(40),tree:'6'.repeat(40)},run:{id:'0',attempt:'1'},main:'index.js',modules:[{path:'index.js',base64:Buffer.from(source).toString('base64'),sha256:hash(source)}],assets:[],migrations:[]};
 const declaration={version:1,project:target.project,compatibilityDate:'2026-09-08',d1:[],r2:[{binding:'AI_IMAGES'}],queues:[],durableObjects:[{binding:'AI_BUDGET',className:'AiAuthority',storage:'sqlite'}],secrets:[{binding:'RER_AI_PRIVACY_TOKEN',environment:'RER_AI_PRIVACY_TOKEN'}],crons:[],vars:{},ai:request};
 const authority={schema:1,enabled:true,accountId:target.accountId,sourceSha:artifact.source.sha,installation:target.worker,environment:target.environment,tenant:'synthetic-tenant',revision:'initial',custody:'original',permitted:request,prices:{[model]:{version:'synthetic-prices',validUntil:Date.now()+86400000,inputMicroUsdPerMillion:450000,outputMicroUsdPerMillion:3200000,imageMicroUsdPerUnit:410}},proofs:{[model]:{reference:'synthetic-provider-edge',kind:'text',maxInputTokens:262144,maxOutputTokens:1024,maxImageUnits:0,mime:''}}};
 return {artifact,declaration,env:{RER_AI_AUTHORITY:JSON.stringify(authority),RER_AI_PRIVACY_TOKEN:'synthetic-private-custody-token-1'}};
}

test('seed AI policy variables refuse without an AI declaration at planning and both deployment doors',async t=>{
 const provider=ownerProvider();t.after(()=>provider.close());const api=cloudflare(provider);
 const target=await ownerTarget(api,{project:'synthetic',environment:'production'});
 const {artifact,declaration,env}=deploymentInputs(target);
 const {ai:_,...disabled}=declaration;
 disabled.secrets=[];
 const folder=await mkdtemp(join(tmpdir(),'native-ai-disabled-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const plan=ownerPlan(target,disabled,artifact);
 for(const name of ['RER_AI_REQUEST','RER_AI_AUTHORITY','RER_AI_ACCOUNT_ID','RER_AI_BUCKET_NAME','RER_AI_PRIVACY_TOKEN','RER_AI_FUTURE_POLICY']) {
  const vars={[name]:'synthetic-seed-policy'};
  for(const source of [disabled,declaration]) assert.throws(()=>ownerPlan(target,{...source,vars},artifact,{env}),e=>e.code==='ai_policy_conflict');
  const supplied={...plan,vars};
  for(const run of [()=>ownerDeploy({api,target,plan:supplied,artifact,statePath:join(folder,'owner.json'),env}),()=>deploy({api,plan:supplied,artifact,env})]) {
   await assert.rejects(run,e=>e.code==='ai_policy_conflict');
   assert.equal(provider.state.writes.length,0);
  }
 }
 await assert.rejects(readFile(join(folder,'owner.json')),e=>e.code==='ENOENT');
});

test('both deployment doors bind approved payer and source before any provider or state mutation',async t=>{
 const provider=ownerProvider();t.after(()=>provider.close());const api=cloudflare(provider);
 const target=await ownerTarget(api,{project:'synthetic',environment:'production'});
 const folder=await mkdtemp(join(tmpdir(),'native-ai-preflight-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 for(const boundary of ['payer','source']) {
  const plannedTarget=boundary==='payer'?{...target,accountId:'b'.repeat(32)}:target;
  const {artifact,declaration,env}=deploymentInputs(plannedTarget);
  const plan=ownerPlan(plannedTarget,declaration,artifact,{env});
  const paired=boundary==='source'?{...artifact,source:{...artifact.source,sha:'7'.repeat(40)}}:artifact;
  const code=boundary==='payer'?'ai-installation-account-mismatch':'ai-source-approval-mismatch';
  const calls=provider.state.calls.length;
  for(const run of [()=>ownerDeploy({api,target,plan,artifact:paired,statePath:join(folder,'owner.json'),env}),()=>deploy({api,plan,artifact:paired,env})]) {
   await assert.rejects(run,e=>e.code===code);
   assert.equal(provider.state.writes.length,0);
   assert.equal(provider.state.calls.length,calls);
  }
 }
 await assert.rejects(readFile(join(folder,'owner.json')),e=>e.code==='ENOENT');
});

test('reserved AI names on every channel and unpaired approval at every entry are refused before any write',async t=>{
 const provider=ownerProvider();t.after(()=>provider.close());const api=cloudflare(provider);
 const target=await ownerTarget(api,{project:'synthetic',environment:'production'});
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-ai-sweep-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'}).trim();
 for(const dir of ['dist/server','dist/client','migrations/core','cells'])await mkdir(join(root,dir),{recursive:true});
 await writeFile(join(root,'.gitignore'),'dist/\n.rer/\ncells/\n');git('init','-q');git('add','.');git('commit','-qm','sweep');
 const sha=git('rev-parse','HEAD'),{artifact:inert,declaration:declared,env:{RER_AI_AUTHORITY:approved}}=deploymentInputs(target);
 const artifact={...inert,source:{sha,tree:git('rev-parse','HEAD^{tree}')}},approval=change=>JSON.stringify({...JSON.parse(approved),sourceSha:sha,...change});
 await writeFile(join(root,'dist/server/index.js'),Buffer.from(inert.modules[0].base64,'base64'));
 const env={CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token,RER_AI_AUTHORITY:approval(),RER_AI_PRIVACY_TOKEN:'synthetic-private-custody-token-1',SEED_CONFIG_0:'synthetic-seed-config'};
 const {ai:_,...plain}={...declared,secrets:[]};
 let cells=0;
 const cli=async(command,declaration,extra=[],values=env)=>{
  const file=`cells/${cells++}.json`;await writeFile(join(root,file),JSON.stringify(declaration));
  await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],...(declaration.ai?{ai:{binding:'AI'}}:{})}));
  return main([command,'--declaration',file,'--environment','production',...extra],values,{fetch:provider.fetch,cwd:root,notice:()=>{}});
 };
 // The one legitimate path: declared ai, the owner's separate approval and the approved private token.
 assert.equal((await cli('deploy',declared)).changed,true);assert.equal((await cli('health',declared)).ok,true);
 const statePath=join(root,'.rer/deploy/production.json'),plans={plain:ownerPlan(target,plain,artifact),ai:ownerPlan(target,declared,artifact,{env})},results=[];
 const refused=async(cell,run,code='ai_policy_conflict',{held=false}={})=>{
  const bytes=await readFile(statePath),writes=provider.state.writes.length;
  // Another run's lock: an entry that locked or settled before refusing would report owner-state-locked instead.
  // Held secrets are read from the live Worker, which owner deploy does only under its own lock.
  if(!held)await writeFile(statePath+'.lock','other-run\n');
  let error;try{await run();}catch(e){error=e;}finally{if(!held)await rm(statePath+'.lock');}
  assert.equal(error?.code,code,`${cell}: ${error?.code??error?.message}`);
  assert.equal(provider.state.writes.length,writes,cell);assert.deepEqual(await readFile(statePath),bytes,cell);
  results.push(`${cell}: ${code}${error.resource?` ${error.resource}`:''}`);
 };
 const seeded={'seed variable':{...plain,vars:{RER_AI_AUTHORITY:approval()}},'origin variable':{...plain,originVar:'RER_AI_REQUEST'},
  'public origin setting':{...plain,originVar:'APP_ORIGIN',publicOriginSetting:'RER_AI_AUTHORITY'},
  'secret binding':{...plain,secrets:[{binding:'RER_AI_AUTHORITY',environment:'SEED_CONFIG_0'}]},'secret source':{...plain,secrets:[{binding:'APP_TOKEN',environment:'RER_AI_PRIVACY_TOKEN'}]},
  'private token without ai':{...plain,secrets:declared.secrets},
  ...Object.fromEntries(['d1','r2','kv','queues'].map(kind=>[`${kind} binding`,{...plain,[kind]:[{binding:'RER_AI_RESOURCE'}]}])),
  'Durable Object binding':{...plain,durableObjects:[{binding:'RER_AI_BUDGET',className:'AiAuthority',storage:'sqlite'}]},'service binding':{...plain,services:[{binding:'RER_AI_SERVICE',project:'upstream'}]},
  'ai: seed policy variable':{...declared,vars:{RER_AI_ACCOUNT_ID:provider.accountId}},'ai: optional private token':{...declared,secrets:[{...declared.secrets[0],optional:true}]},
  'ai: private token from another source':{...declared,secrets:[{binding:'RER_AI_PRIVACY_TOKEN',environment:'SEED_CONFIG_0'}]},'ai: native binding':{...declared,ai:{...declared.ai,binding:'RER_AI_NATIVE'}}};
 for(const [channel,declaration] of Object.entries(seeded)){
  await refused(`${channel} x ownerPlan`,()=>ownerPlan(target,declaration,artifact,{env}));
  for(const command of ['deploy','dry-run','health'])await refused(`${channel} x CLI ${command}`,()=>cli(command,declaration));
  // The secret entry reads only secrets: it runs where the reserved name is in that channel.
  const secret=declaration.secrets.find(item=>/RER_AI_/.test(item.binding+item.environment)&&!(declaration.ai&&item===declared.secrets[0]));
  if(secret)await refused(`${channel} x CLI secret --set`,()=>cli('secret',declaration,['--set',secret.binding]));
 }
 const supplied={'plan variable':{...plans.plain,vars:{RER_AI_AUTHORITY:approval()}},'plan secret binding':{...plans.plain,secrets:[{binding:'RER_AI_AUTHORITY',environment:'SEED_CONFIG_0'}]},
  'plan secret source':{...plans.plain,secrets:[{binding:'APP_TOKEN',environment:'RER_AI_PRIVACY_TOKEN'}]},'plan resource binding':{...plans.plain,r2:[{binding:'RER_AI_RESOURCE',name:'synthetic-production-rer-ai-resource'}]},
  'ai plan: extra variable':{...plans.ai,vars:{...plans.ai.vars,RER_AI_FUTURE:'synthetic'}},'ai plan: extra secret':{...plans.ai,secrets:[...plans.ai.secrets,{binding:'RER_AI_FUTURE',environment:'SEED_CONFIG_0'}]}};
 const doors={ownerDeploy:(plan,paired=artifact)=>ownerDeploy({api,target,plan,artifact:paired,statePath,env}),deploy:(plan,paired=artifact)=>deploy({api,plan,artifact:paired,env}),ownerHealth:plan=>ownerHealth({api,target,plan,statePath})};
 for(const [channel,plan] of Object.entries(supplied))for(const [door,run] of Object.entries(doors))await refused(`${channel} x ${door}`,()=>run(plan));
 // Secrets the live Worker already holds: an upload inherits declared ones and keeps every other one.
 provider.state.secrets.push({name:'RER_AI_FUTURE',value:'synthetic-held'});
 for(const [door,run] of Object.entries(doors))await refused(`held secret x ${door}`,()=>run(plans.ai),undefined,{held:true});
 for(const command of ['deploy','dry-run','health'])await refused(`held secret x CLI ${command}`,()=>cli(command,declared),undefined,{held:true});
 await refused('held secret x CLI secret --set',()=>cli('secret',declared,['--set','RER_AI_PRIVACY_TOKEN']),undefined,{held:true});
 provider.state.secrets=provider.state.secrets.filter(item=>item.name!=='RER_AI_FUTURE');
 for(const door of ['ownerDeploy','deploy'])await refused(`held private token with ai off x ${door}`,()=>doors[door](plans.plain),undefined,{held:true});
 for(const command of ['deploy','dry-run'])await refused(`held private token with ai off x CLI ${command}`,()=>cli(command,plain),undefined,{held:true});
 // An interrupted secret change whose successor is ready to settle: no stale approval may settle it.
 const saved=JSON.parse(await readFile(statePath));
 saved.pendingSecret={bindings:['EXTRA'],present:true,versionId:saved.receipt.provider.versionId,names:provider.state.secrets.map(item=>item.name)};
 await api.request(`/workers/scripts/${target.worker}/secrets`,{method:'PUT',body:{name:'EXTRA',text:'synthetic-extra-secret',type:'secret_text'}});await writeFile(statePath,JSON.stringify(saved));
 for(const [cell,change] of Object.entries({'stale source approval':{sourceSha:'7'.repeat(40)},'approval for another payer':{accountId:'b'.repeat(32)}}))
  for(const command of ['deploy','dry-run','health'])await refused(`${cell} x CLI ${command}`,()=>cli(command,declared,[],{...env,RER_AI_AUTHORITY:approval(change)}));
 const moved={...artifact,source:{...artifact.source,sha:'7'.repeat(40)}},elsewhere={...target,accountId:'b'.repeat(32)};
 const payer=ownerPlan(elsewhere,declared,artifact,{env:{...env,RER_AI_AUTHORITY:approval({accountId:elsewhere.accountId})}});
 for(const door of ['ownerDeploy','deploy']){
  await refused(`artifact paired with another source x ${door}`,()=>doors[door](plans.ai,moved),'ai-source-approval-mismatch');
  await refused(`plan for another payer x ${door}`,()=>doors[door](payer),'ai-installation-account-mismatch');
 }
 await refused('approval for another deployment x ownerHealth',()=>doors.ownerHealth(ownerPlan(target,declared,moved,{env:{...env,RER_AI_AUTHORITY:approval({sourceSha:moved.source.sha})}})),'ai-source-approval-mismatch');
 assert.equal((await cli('health',declared)).ok,true);assert.equal(JSON.parse(await readFile(statePath)).pendingSecret,undefined);
 // Producers outside the owner kit bind names directly: container settings, built variables and packages.
 await writeFile(join(root,'deploy.json'),JSON.stringify(plain));await writeFile(join(root,'cells/container.env'),'RER_AI_AUTHORITY={}\n',{mode:0o600});
 await refused('setting x container deploy',()=>deployInputs({root,envFile:'cells/container.env'}));
 await refused('built variable x container image and hosted demo build',()=>checkImageVariables(root,{RER_AI_REQUEST:'{}'},[]));
 const spec={schema:1,resources:[],migrations:[],compatibilityDate:'2026-09-08',compatibilityFlags:[],durableObjects:[],durableObjectMigrations:[],publicVariables:{},secretNames:[],schedules:[],queueConsumers:[],healthPath:'/health',recovery:'none'};
 validateCandidateSpec(spec);
 for(const [cell,change] of Object.entries({'package variable':{publicVariables:{RER_AI_AUTHORITY:'{}'}},'package secret':{secretNames:['RER_AI_PRIVACY_TOKEN']},'package binding':{resources:[{kind:'r2',binding:'RER_AI_RESOURCE'}]},'package surface variable':{surfaces:{app:{path:'/',originVariable:'RER_AI_REQUEST'}}}}))
  await refused(`${cell} x delivery package`,()=>validateCandidateSpec({...spec,...change}));
 // Turning AI off: remove the token while it is declared, then deploy without ai. Lookalike names stay ordinary.
 assert.equal((await cli('secret',declared,['--unset','RER_AI_PRIVACY_TOKEN'])).ok,true);
 const lookalikes={AI_ENABLED:'false',rer_ai_authority:'synthetic-case-lookalike',APP_RER_AI_AUTHORITY:'synthetic-prefixed-lookalike'};
 assert.equal((await cli('deploy',{...plain,vars:lookalikes})).changed,true);
 const bound=provider.state.settings.bindings;
 assert.ok(!bound.some(item=>item.name.startsWith('RER_AI_')||item.type==='ai'));
 for(const [name,text] of Object.entries(lookalikes))assert.ok(bound.some(item=>item.name===name&&item.text===text));
 t.diagnostic(results.join('\n'));
});

test('every owner command, Worker write and configuration family passes the one runtime-name projection',async t=>{
 const provider=ownerProvider();t.after(()=>provider.close());const api=cloudflare(provider);
 const target=await ownerTarget(api,{project:'synthetic',environment:'production'});
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-ai-projection-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=Fixture','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'}).trim();
 for(const dir of ['dist/server','dist/client','migrations/core'])await mkdir(join(root,dir),{recursive:true});
 const {artifact:inert,declaration:declared,env:{RER_AI_AUTHORITY:approved}}=deploymentInputs(target);
 const declaration={...declared,secrets:[...declared.secrets,{binding:'A_SECRET',environment:'A_SECRET'},{binding:'B_SECRET',environment:'B_SECRET',optional:true}]};
 await writeFile(join(root,'.gitignore'),'dist/\n.rer/\n');await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));git('init','-q');git('add','.');git('commit','-qm','projection');
 await writeFile(join(root,'dist/server/index.js'),Buffer.from(inert.modules[0].base64,'base64'));
 await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],ai:{binding:'AI'}}));
 const authority={...JSON.parse(approved),sourceSha:git('rev-parse','HEAD')};
 const env={CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token,RER_AI_AUTHORITY:JSON.stringify(authority),RER_AI_PRIVACY_TOKEN:'synthetic-private-custody-token-2',A_SECRET:'synthetic-a',B_SECRET:'synthetic-b'};
 // Every binding-bearing Worker write, as the provider edge receives it.
 const sent=[];
 const fetch=async(input,init={})=>{
  const path=new URL(input).pathname.replace(/^\/client\/v4\/accounts\/[^/]+/,'');
  if(/^\/workers\/scripts\//.test(path)&&['PUT','POST','PATCH'].includes(init.method)){
   const part=init.body instanceof FormData?init.body.get('metadata')??init.body.get('settings'):null;
   if(part)sent.push(...JSON.parse(await part.text()).bindings);
   else if(path.endsWith('/secrets'))sent.push({type:'secret_text',name:JSON.parse(init.body).name});
  }
  return provider.fetch(input,init);
 };
 const cli=(command,extra=[])=>main([command,'--declaration','deploy.json','--environment','production',...extra],env,{fetch,cwd:root,notice:()=>{}});
 // The approved path emits exactly the derived variables and the private-token pair, through deploy, health and each secret write.
 assert.equal((await cli('deploy')).changed,true);assert.equal((await cli('health')).ok,true);
 for(const change of [['--set','A_SECRET'],['--set','A_SECRET','--set','B_SECRET'],['--unset','B_SECRET']])assert.equal((await cli('secret',change)).ok,true);
 const derived={RER_AI_REQUEST:canonical(declared.ai),RER_AI_AUTHORITY:canonical(authority),RER_AI_ACCOUNT_ID:provider.accountId,RER_AI_BUCKET_NAME:'synthetic-production-ai-images'};
 const reserved=sent.filter(binding=>binding.name.startsWith('RER_AI_'));
 assert.ok(reserved.length&&reserved.every(binding=>binding.type==='inherit'?[...AI_VARIABLES,AI_PRIVACY_TOKEN].includes(binding.name)
  :binding.type==='plain_text'?binding.text===derived[binding.name]:binding.type==='secret_text'&&binding.name===AI_PRIVACY_TOKEN),JSON.stringify(reserved));
 const statePath=join(root,'.rer/deploy/production.json'),saved=JSON.parse(await readFile(statePath)),held=provider.state.secrets.map(item=>item.name);
 // A reserved name the live Worker serves outside the approval: a secret change would inherit it, every other
 // command reads it back. Removal deletes it; a dry run reads only the secrets a fresh upload would keep.
 const foreign={type:'plain_text',name:'RER_AI_LIVE',text:'synthetic-live'},live=[provider.state.settings.bindings,provider.state.version.resources.bindings];
 for(const bindings of live)bindings.push(foreign);
 const extras={secret:[['--set','A_SECRET'],['--set','A_SECRET','--set','B_SECRET']],'record-owner':[['--outcome','claimed']]};
 for(const command of COMMANDS.filter(command=>!['remove','dry-run'].includes(command)))for(const extra of extras[command]??[[]]){
  const bytes=await readFile(statePath),writes=provider.state.writes.length;
  await assert.rejects(cli(command,extra),e=>e.code==='ai_policy_conflict',`live x ${command} ${extra.join(' ')}`);
  assert.equal(provider.state.writes.length,writes);assert.deepEqual(await readFile(statePath),bytes);
 }
 for(const bindings of live)bindings.splice(bindings.indexOf(foreign),1);
 // An interrupted change that would leave a reserved name: applied at the edge, then staged as a several-secret copy.
 for(const mode of ['applied','staged']){
  const state=structuredClone(saved),bindings=['RER_AI_PENDING',...(mode==='staged'?['B_SECRET']:[])];
  state.pendingSecret={bindings,present:true,versionId:state.receipt.provider.versionId,names:held.filter(name=>!bindings.includes(name)),...(mode==='staged'?{copy:'c3'.repeat(16)}:{})};
  if(mode==='applied')await api.request(`/workers/scripts/${target.worker}/secrets`,{method:'PUT',body:{name:'RER_AI_PENDING',text:'synthetic-pending',type:'secret_text'}});
  else await uploadSecretCopy(api,target.worker,await activeWorker(api,target.worker),{marker:state.pendingSecret.copy,changes:[{binding:'RER_AI_PENDING',value:'synthetic-pending'},{binding:'B_SECRET',value:'synthetic-b'}]});
  await writeFile(statePath,JSON.stringify(state));
  const bytes=await readFile(statePath),writes=provider.state.writes.length;
  // Another run's lock: a command that locked or settled before refusing would report owner-state-locked.
  // Removal deletes the Worker and keeps serving nothing, so it alone settles without runtime names.
  for(const command of COMMANDS.filter(command=>command!=='remove')){
   await writeFile(statePath+'.lock','other-run\n');
   let error;try{await cli(command,extras[command]?.[0]);}catch(e){error=e;}finally{await rm(statePath+'.lock');}
   assert.equal(error?.code,'ai_policy_conflict',`${mode} x ${command}: ${error?.code??error?.message}`);
   assert.equal(provider.state.writes.length,writes,`${mode} x ${command}`);assert.deepEqual(await readFile(statePath),bytes,`${mode} x ${command}`);
  }
 }
 // Every configuration family a container or hosted-demo build binds, read back or planned; lookalikes stay ordinary.
 for(const [family,{type,field}] of Object.entries({vars:{type:'plain_text',field:'vars'},...CONFIG_FAMILIES}))for(const name of ['RER_AI_FAMILY','APP_RER_AI_FAMILY']){
  const item={binding:name,name},config=family==='vars'?{vars:{[name]:'synthetic'}}:{[family]:field===null?{binding:name}:field===undefined?[item]:{[field]:[item]}};
  if(name.startsWith('APP_')){checkImageBindings(config);continue;}
  for(const gate of [()=>checkImageBindings(config),()=>nativeBindings(config),()=>verifyBindings([{type,name,text:'synthetic'}],[])])
   assert.throws(gate,e=>e.code==='ai_policy_conflict'||['ai','service'].includes(type)&&/undeclared-native-ai-binding|binding-readback-mismatch/.test(e.message),`${family}`);
 }
 // The builders apply it before emitting a package: to a name the build carries, and to one only the seed's own configuration declares.
 const {buildContainer}=await import('../../container/build.mjs'),{buildDemo}=await import('../../demo-host/build.mjs'),base=join(import.meta.dirname,'../../..');
 for(const [label,config] of Object.entries({built:{r2_buckets:[{binding:'RER_AI_BUILT',bucket_name:'synthetic-built'}]},declared:{assets:{binding:'RER_AI_DECLARED',directory:'dist/client'}}}))for(const kind of ['container','hosted demo']){
  const app=await realpath(await mkdtemp(join(tmpdir(),'native-ai-build-')));t.after(()=>rm(app,{recursive:true,force:true}));
  for(const dir of ['src','dist/client'])await mkdir(join(app,dir),{recursive:true});
  await symlink(join(base,'default-seed/node_modules'),join(app,'node_modules'));await writeFile(join(app,'package.json'),'{"type":"module"}');
  await writeFile(join(app,'src/server.mjs'),`export {default,AiAuthority} from ${JSON.stringify(join(base,'modules/ai/tests/native-worker.mjs'))};`);
  await writeFile(join(app,'vite.config.mjs'),"import {cloudflare} from '@cloudflare/vite-plugin'; export default {logLevel:'silent',plugins:[cloudflare({inspectorPort:false,viteEnvironment:{name:'ssr'}})],environments:{ssr:{build:{outDir:'dist/server'}}},builder:{buildApp:async b=>b.build(b.environments.ssr)}};");
  await writeFile(join(app,'wrangler.jsonc'),JSON.stringify({name:'synthetic-build',main:'src/server.mjs',compatibility_date:'2026-09-08',compatibility_flags:['nodejs_compat'],...config}));
  const output=join(app,'bundle');
  await assert.rejects(kind==='container'?buildContainer(app,{engine:'workerd',declaration:{},output}):buildDemo(app,output,{}),e=>e.code==='ai_policy_conflict',`${label} x ${kind}`);
  await assert.rejects(readdir(output),{code:'ENOENT'});
 }
});
