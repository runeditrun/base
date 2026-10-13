import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { unpackArtifact,validateBuildConfig,compareModuleBytes } from '../t016/artifact.mjs';
import { observation,validateFacts } from '../t016/facts.mjs';
import { validateQualification } from '../t016/observations.mjs';
import { publicSource } from '../t016/profile.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';
import { selectMailbox,gmailMailbox } from '../../scripts/qualification/mailbox.mjs';
import { sendAndReadMail } from '../../scripts/qualification/happytohelp.mjs';
import { runtimeImages,isolationFlags,dockerEnvironment } from '../t016/isolation.mjs';
import { runT016 } from '../t016/run.mjs';
import { deploymentIdentity,r2DisabledReadback } from '../t016/cloudflare.mjs';
import { verifyAppliedBytes,recheckState,snapshotState } from '../t016/state.mjs';
import { isolationAttestation } from '../t016/trust-boundary.mjs';
import { browserJourney } from '../../scripts/qualification/browser.mjs';

function scratch(t) {
 const root=mkdtempSync(join(process.env.T016_TEST_TMP,'repair-')); t.after(()=>rmSync(root,{recursive:true,force:true}));return root;
}
function tar(entries) {
 const chunks=[];
 for(const {name,content='',type='0',link=''} of entries){
  const bytes=Buffer.from(content),header=Buffer.alloc(512);
  header.write(name,0,100);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
  header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);
  header.fill(32,148,156);header.write(type,156);header.write(link,157,100);header.write('ustar\0',257);
  const sum=[...header].reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
 }
 return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
test('artifact handoff preserves exact bytes and rejects link, traversal, duplicate and device archives',t=>{
 const root=scratch(t),bytes=tar([{name:'dist/server/index.js',content:'export default {}'}]);
 const files=unpackArtifact(bytes,root);
 assert.equal(files[0].sha256,digest('export default {}')); assert.equal(readFileSync(join(root,files[0].path),'utf8'),'export default {}');
 for(const entries of [
  [{name:'dist/../../controller.mjs',content:'bad'}],
  [{name:'dist/server/link',type:'2',link:'/proc/1/environ'}],
  [{name:'dist/server/hard',type:'1',link:'dist/server/index.js'}],
  [{name:'dist/server/device',type:'3'}],
  [{name:'dist/server/x',content:'a'},{name:'dist/server/x',content:'b'}],
  [{name:'dist/server/override',type:'x',content:'PAX'}],
 ]) assert.throws(()=>unpackArtifact(tar(entries),scratch(t)));
 assert.equal(existsSync(join(root,'controller.mjs')),false);
});
test('Docker archive prefixing cannot make absolute or parent paths safe',t=>{
 assert.throws(()=>unpackArtifact(tar([{name:'../control',content:'bad'}]),scratch(t),'dist'));
 assert.throws(()=>unpackArtifact(tar([{name:'/absolute',content:'bad'}]),scratch(t),'dist'));
 const files=unpackArtifact(tar([{name:'./server/index.js',content:'ok'}]),scratch(t),'dist');
 assert.equal(files[0].path,'dist/server/index.js');
});
test('Docker PAX names receive canonical validation and cannot override file size',t=>{
 const pax=(key,value)=>{let n=key.length+value.length+4;while(String(n).length+key.length+value.length+3!==n)n=String(n).length+key.length+value.length+3;return `${n} ${key}=${value}\n`;};
 const entry=value=>[{name:'PaxHeader',type:'x',content:pax('path',value)},{name:'placeholder',content:'worker'}];
 const files=unpackArtifact(tar(entry('server/index.js')),scratch(t),'dist');
 assert.equal(files[0].sha256,digest('worker'));
 for(const value of ['../controller','/controller','server/../../controller'])assert.throws(()=>unpackArtifact(tar(entry(value)),scratch(t),'dist'));
 assert.throws(()=>unpackArtifact(tar([{name:'PaxHeader',type:'x',content:pax('size','1')},{name:'server/index.js',content:'worker'}]),scratch(t),'dist'));
});
const prepared={name:'t016-1-1',account_id:'a'.repeat(32),main:'/seed/src/server.ts',
 d1_databases:[{binding:'DB',database_id:'db-id',migrations_dir:'/seed/.generated/migrations'}],vars:{APP_ORIGIN:'https://t016-1-1.example.workers.dev'}};
const emitted={...prepared,main:'index.js',assets:{directory:'../client'},no_bundle:true};
test('artifact config refuses rebundling, credential paths and changed resources',()=>{
 validateBuildConfig(prepared,emitted);
 for(const change of [{no_bundle:false},{main:'/controller/run.mjs'},{assets:{directory:'/source'}},{account_id:'b'.repeat(32)},{build:{command:'steal'}},{rules:[{type:'Text',globs:['../../*']}]}])
  assert.throws(()=>validateBuildConfig(prepared,{...emitted,...change}));
});
test('serving bytes require the complete exact uploaded module set',()=>{
 const files=[{path:'dist/server/index.js',sha256:digest('real')},{path:'dist/server/wrangler.json',sha256:digest('{}')}];
 compareModuleBytes(files,new Map([['index.js',Buffer.from('real')]]));
 for(const modules of [new Map(),new Map([['index.js',Buffer.from('different')]]),new Map([['index.js',Buffer.from('real')],['extra.js',Buffer.from('extra')]])])
  assert.throws(()=>compareModuleBytes(files,modules));
});
test('typed evidence retains facts and rejects raw logs, tokens, hash-only and altered hashes',async()=>{
 const facts={ownerId:'owner-id',projectId:'project-id',setupClosed:true,loginVerified:true};
 assert.deepEqual(observation('owner',facts).facts,facts);
 for(const extra of ['token','password','rawLog','headers','cookie']) assert.throws(()=>validateFacts('owner',{...facts,[extra]:'not-evidence'}));
 const report=await runT016('t016-r2-on',{});
 assert.equal(validateQualification(report,report.proof).version,2);
 for(const change of [
  {observations:[{phase:'owner',passed:true,sha256:digest('hidden'),utc:new Date().toISOString()}]},
  {observations:[{...report.observations[0],sha256:'a'.repeat(64)}]},
  {failure:null,result:'passed'},
 ])assert.throws(()=>validateQualification({...report,...change},report.proof));
});
test('missing owner mailbox choice is explicit; an available Gmail token does not choose Gmail',()=>{
 assert.throws(()=>selectMailbox({T016_GMAIL_ACCESS_TOKEN:'test-only',T016_TEST_MAILBOX:'test@example.test'}),/choice-pending/);
 assert.throws(()=>selectMailbox({T016_MAILBOX_ADAPTER:'imap'}),/adapter-unsupported/);
});
test('Gmail readback returns allowlisted real identifiers and content hash',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let listed=false;
 globalThis.fetch=async url=>Response.json(url.endsWith('/profile')?{emailAddress:'test@example.test'}:url.includes('format=full')?{
  internalDate:'1000',payload:{headers:[{name:'To',value:'test@example.test'},{name:'From',value:'Qualification t016-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa <sender@example.test>'},
   {name:'Subject',value:'HappyToHelp email verification'},{name:'Message-ID',value:'<message@example.test>'}],body:{data:Buffer.from('Your configured HappyToHelp email provider delivered this verification message.').toString('base64url')}}
 }:{messages:listed?[{id:'abc123'}]:[]});
 const mailbox=gmailMailbox({token:'test-only',address:'test@example.test'}),before=await mailbox.snapshot();listed=true;
 const receipt=await mailbox.readNew(before,'sender@example.test',999,'t016-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
 validateFacts('mailbox',receipt);assert.equal(receipt.mailboxMessageId,'abc123');assert.equal(receipt.messageId,'<message@example.test>');
 assert(!JSON.stringify(receipt).includes('test-only'));
});
test('selected SendGrid rejection fails before durable readback and never invents mailbox delivery',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 globalThis.fetch=async (url,options)=>url.includes('gmail.googleapis.com')?Response.json(url.endsWith('/profile')?{emailAddress:'test@example.test'}:{}):
  url.endsWith('/test')?Response.json({}, {status:502}):Response.json(options.method==='PUT'?{updated:true}:{configured:true});
 await assert.rejects(sendAndReadMail({origin:'https://throwaway.example',env:{T016_MAILBOX_ADAPTER:'gmail',T016_GMAIL_ACCESS_TOKEN:'test-only',
  T016_TEST_MAILBOX:'test@example.test',T016_SENDGRID_FROM:'sender@example.test'},state:{owner:{projectId:'project-id',token:'session-test-only'}},
  observe(){assert.fail('No success observation should exist');},deliveryReadback(){assert.fail('No durable readback after rejection');}}),/http-status/);
});
test('real R2 error persists status and code; a disabled-looking error without code cannot qualify',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let code=10042;
 globalThis.fetch=async()=>Response.json({success:false,errors:[{code,message:'Enable R2 to continue'}]},{status:403});
 const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only'};
 assert.deepEqual(await r2DisabledReadback(env),{status:403,code:10042});
 code=undefined;await assert.rejects(r2DisabledReadback(env),/error-code/);
});
test('mutable images and missing isolation attestation stop before network/provider effects',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);globalThis.fetch=()=>assert.fail('Network must not run');
 assert.throws(()=>runtimeImages({T016_CONTROLLER_IMAGE:'ghcr.io/runeditrun/t016-controller:latest'}),/runtime-unconfigured/);
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'runeditrun/base',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
  CF_THROWAWAY_API_TOKEN:'test-only',CF_THROWAWAY_ACCOUNT_ID:'a'.repeat(32)};
 assert.equal((await runT016('t016-r2-off',env)).failure,'reviewed-runtime-unconfigured');
 const images=Object.fromEntries(['controller','build','browser'].map(role=>[role,'ghcr.io/runeditrun/t016-'+role+'@sha256:'+'a'.repeat(64)]));
 for(const [role,value] of Object.entries(images))env['T016_'+role.toUpperCase()+'_IMAGE']=value;
 assert.equal((await runT016('t016-r2-off',env)).failure,'isolation-unqualified');
 assert.notEqual(isolationAttestation(images,'a'.repeat(40)),isolationAttestation(images,'b'.repeat(40)));
});
test('evidence binds isolation to the exact reviewed images and controller',async()=>{
 const report=await runT016('t016-r2-off',{}), controllerSha='a'.repeat(40);
 const images={controller:'sha256:'+'1'.repeat(64),build:'sha256:'+'2'.repeat(64),browser:'sha256:'+'3'.repeat(64)};
 const facts={controllerSha,attestation:isolationAttestation(images,controllerSha),controllerImage:images.controller,buildImage:images.build,browserImage:images.browser};
 validateQualification({...report,observations:[observation('isolation',facts),...report.observations]},report.proof);
 assert.throws(()=>validateQualification({...report,observations:[observation('isolation',{...facts,buildImage:'sha256:'+'4'.repeat(64)}),...report.observations]},report.proof),/isolation-provenance/);
 assert.deepEqual(runtimeImages({T016_CONTROLLER_IMAGE:images.controller,T016_BUILD_IMAGE:images.build,T016_BROWSER_IMAGE:images.browser}),images);
});
test('sandbox flags and Docker environment expose neither parent secrets nor host namespaces',()=>{
 const env=dockerEnvironment({PATH:'/bin',HOME:'/safe',RUNNER_TEMP:'/scratch',CF_THROWAWAY_API_TOKEN:'test-only',EVIDENCE_WRITE_TOKEN:'test-only'});
 assert(!JSON.stringify(env).includes('test-only'));
 assert(isolationFlags.includes('--read-only'));assert(isolationFlags.includes('--cap-drop=ALL'));
 assert(!isolationFlags.some(flag=>/privileged|pid=host|network=host/.test(flag)));
});
test('immutable migration bytes reject edited, added and deleted applied history',()=>{
 const prior=[{name:'0001_initial.sql',sha256:digest('original')}];
 verifyAppliedBytes(prior,structuredClone(prior));
 for(const next of [[],[{...prior[0],sha256:digest('changed')}],[...prior,{name:'0002_new.sql',sha256:digest('new')}]])
  assert.throws(()=>verifyAppliedBytes(prior,next),/migration-bytes-changed/);
});
test('browser runtime failure is never a widget success and browser is closed',async()=>{
 let closed=false;
 const chromium={launch:async()=>({newPage:async()=>({on(){},goto:async()=>{throw new Error('startup-failed');}}),close:async()=>{closed=true;}})};
 await assert.rejects(browserJourney({origin:'https://throwaway.example',owner:{projectId:'project-id'},password:'test-password'},chromium),/startup-failed/);
 assert(closed);
});
test('newer unrelated Cloudflare versions cannot satisfy a deployment receipt',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 globalThis.fetch=async()=>Response.json({success:true,result:{deployments:[{id:'deployment-id',versions:[{version_id:'11111111-1111-1111-1111-111111111111',percentage:100}]}]}});
 await assert.rejects(deploymentIdentity({CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only',H2H_RESOURCE_PREFIX:'t016-1-1'},
  {output:'Current Version ID: 22222222-2222-2222-2222-222222222222',artifact:{},stage:'initial'}),/deployment-readback-failed/);
});
test('workflow binds existing SendGrid key and gates credentials on Linux isolation',()=>{
 const text=readFileSync('.github/workflows/live-proof.yml','utf8');
 assert(text.includes('&& secrets.SENDGRID_API_KEY'));assert(!text.includes('secrets.T016_SENDGRID_API_KEY'));
 const gate=text.split('  isolation:')[1].split('  execute:')[0];assert(!gate.includes('secrets.'));assert(!gate.includes('environment:'));
 assert(text.includes('T016_ISOLATION_ATTESTATION:'));assert(text.includes("vars.T016_MAILBOX_ADAPTER == 'gmail'"));
});
test('serving version is bound to exact module and static asset bytes, with race rejection',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 const versionId='11111111-1111-1111-1111-111111111111';
 const artifact={sourceSha:publicSource.sha,artifactSha256:digest('artifact'),files:[
  {path:'dist/server/index.js',sha256:digest('worker')},
  {path:'dist/server/wrangler.json',sha256:digest('{}')},
  {path:'dist/client/widget.js',sha256:digest('widget')},
 ]};
 let module='worker',asset='widget',race=false,reads=0;
 globalThis.fetch=async url=>{
  if(url.endsWith('/deployments')){reads++;return Response.json({success:true,result:{deployments:[{id:race&&reads>1?'changed':'deployment-id',versions:[{version_id:versionId,percentage:100}]}]}});}
  if(url.endsWith('/widget.js'))return new Response(asset);
  const form=new FormData();form.append('index.js',new Blob([module],{type:'application/javascript'}),'index.js');return new Response(form);
 };
 const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only',H2H_RESOURCE_PREFIX:'t016-1-1',H2H_PUBLIC_ORIGIN:'https://t016-1-1.example.workers.dev'};
 const run=()=>deploymentIdentity(env,{output:'Current Version ID: '+versionId,artifact,stage:'initial'});
 const receipt=await run();validateFacts('deploy',receipt);assert.equal(receipt.versionId,versionId);assert.equal(receipt.sourceSha,publicSource.sha);
 module='changed';await assert.rejects(run(),/module-bytes-mismatch/);
 module='worker';asset='changed';await assert.rejects(run(),/asset-bytes-mismatch/);
 asset='widget';race=true;reads=0;await assert.rejects(run(),/version-raced/);
});
test('upgrade readback detects changed representative rows and missing R2 bytes before login can mask loss',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 const state={owner:{userId:'owner-id',projectId:'project-id',token:'test-session'},
  reply:{conversationId:'conversation-id',visitorId:'visitor-id',visitorMessageId:'message-1',operatorMessageId:'message-2',
   requestSha256:digest('request'),replySha256:digest('reply')},requestContent:'request',replyContent:'reply',
  conversationId:'conversation-id',media:{mediaId:'media-id',sha256:digest('media')}};
 let changed=false,media='media';
 const migrations=[{name:'0001_initial.sql',sha256:digest('sql')}];
 const read=async sql=>sql.includes('d1_migrations')?[{id:1,name:'0001_initial.sql',applied_at:'2026-01-01'}]:
  sql.includes('FROM messages')?[
   {id:'message-1',conversation_id:'conversation-id',actor_id:'visitor-id',actor_role:'contact',content:changed?'changed':'request'},
   {id:'message-2',conversation_id:'conversation-id',actor_id:'owner-id',actor_role:'owner',content:'reply'}]:
  sql.includes('FROM memberships')?[{role:'owner'}]:sql.includes('FROM media')?[{message_id:'message-1'}]:[{id:'representative-id'}];
 globalThis.fetch=async()=>new Response(media);
 const before=await snapshotState({read,state,origin:'https://throwaway.example',migrations});
 changed=true;
 await assert.rejects(recheckState({before,read,state,origin:'https://throwaway.example',migrations,previousMigrations:migrations,
  browser(){assert.fail('Cannot verify login over lost prior data');}}),/prior-data-changed/);
 changed=false;media='lost';
 await assert.rejects(snapshotState({read,state,origin:'https://throwaway.example',migrations}),/prior-media-changed/);
});
