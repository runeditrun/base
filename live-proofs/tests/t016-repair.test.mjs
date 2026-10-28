import { strictUnpackerRows } from './strict-unpacker.mjs'
import { runRows } from '../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { unpackArtifact,validateBuildConfig,compareModuleBytes } from '../t016/artifact.mjs';
import { observation,validateFacts } from '../t016/facts.mjs';
import { validateQualification } from '../t016/observations.mjs';
import { publicSource } from '../t016/profile.mjs';
import { digest } from '../../scripts/qualification/operations.mjs';
import { selectMailbox } from '../../scripts/qualification/mailbox.mjs';
import { runtimeImages,isolationFlags,dockerEnvironment } from '../t016/isolation.mjs';
import { runT016 } from '../t016/run.mjs';
import { deploymentIdentity } from '../t016/cloudflare.mjs';
import { isolationAttestation } from '../t016/trust-boundary.mjs';

const artifactRows = []
const evidenceRows = []
const isolationRows = []
const deploymentRows = []

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
artifactRows.push(['artifact handoff preserves exact bytes and rejects link, traversal, duplicate and device archives', {}, t=>{
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
}]);
artifactRows.push(['Docker archive prefixing cannot make absolute or parent paths safe', {}, t=>{
 assert.throws(()=>unpackArtifact(tar([{name:'../control',content:'bad'}]),scratch(t),'dist'));
 assert.throws(()=>unpackArtifact(tar([{name:'/absolute',content:'bad'}]),scratch(t),'dist'));
 const files=unpackArtifact(tar([{name:'./server/index.js',content:'ok'}]),scratch(t),'dist');
 assert.equal(files[0].path,'dist/server/index.js');
}]);
artifactRows.push(['Docker PAX names receive canonical validation and cannot override file size', {}, t=>{
 const pax=(key,value)=>{let n=key.length+value.length+4;while(String(n).length+key.length+value.length+3!==n)n=String(n).length+key.length+value.length+3;return `${n} ${key}=${value}\n`;};
 const entry=value=>[{name:'PaxHeader',type:'x',content:pax('path',value)},{name:'placeholder',content:'worker'}];
 const files=unpackArtifact(tar(entry('server/index.js')),scratch(t),'dist');
 assert.equal(files[0].sha256,digest('worker'));
 for(const value of ['../controller','/controller','server/../../controller'])assert.throws(()=>unpackArtifact(tar(entry(value)),scratch(t),'dist'));
 assert.throws(()=>unpackArtifact(tar([{name:'PaxHeader',type:'x',content:pax('size','1')},{name:'server/index.js',content:'worker'}]),scratch(t),'dist'));
}]);
const prepared={name:'t016-1-1',account_id:'a'.repeat(32),main:'/seed/src/server.ts',
 d1_databases:[{binding:'DB',database_id:'db-id',migrations_dir:'/seed/.generated/migrations'}],vars:{APP_ORIGIN:'https://t016-1-1.example.workers.dev'}};
const emitted={...prepared,main:'index.js',assets:{directory:'../client'},no_bundle:true};
artifactRows.push(['artifact config refuses rebundling, credential paths and changed resources', {}, ()=>{
 validateBuildConfig(prepared,emitted);
 for(const change of [{no_bundle:false},{main:'/controller/run.mjs'},{assets:{directory:'/source'}},{account_id:'b'.repeat(32)},{build:{command:'steal'}},{rules:[{type:'Text',globs:['../../*']}]}])
  assert.throws(()=>validateBuildConfig(prepared,{...emitted,...change}));
}]);
deploymentRows.push(['serving bytes require the complete exact uploaded module set', {}, ()=>{
 const files=[{path:'dist/server/index.js',sha256:digest('real')},{path:'dist/server/wrangler.json',sha256:digest('{}')}];
 compareModuleBytes(files,new Map([['index.js',Buffer.from('real')]]));
 for(const modules of [new Map(),new Map([['index.js',Buffer.from('different')]]),new Map([['index.js',Buffer.from('real')],['extra.js',Buffer.from('extra')]])])
  assert.throws(()=>compareModuleBytes(files,modules));
}]);
evidenceRows.push(['typed evidence retains facts and rejects raw logs, tokens, hash-only and altered hashes', {}, async()=>{
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
}]);
evidenceRows.push(['missing owner mailbox choice is explicit; an available Gmail token does not choose Gmail', {}, ()=>{
 assert.throws(()=>selectMailbox({T016_GMAIL_ACCESS_TOKEN:'test-only',T016_TEST_MAILBOX:'test@example.test'}),/choice-pending/);
 assert.throws(()=>selectMailbox({T016_MAILBOX_ADAPTER:'imap'}),/adapter-unsupported/);
}]);
isolationRows.push(['mutable images and missing isolation attestation stop before network/provider effects', {}, async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);globalThis.fetch=()=>assert.fail('Network must not run');
 assert.throws(()=>runtimeImages({T016_CONTROLLER_IMAGE:'ghcr.io/runeditrun/t016-controller:latest'}),/runtime-unconfigured/);
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'runeditrun/base',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
  CF_THROWAWAY_API_TOKEN:'test-only',CF_THROWAWAY_ACCOUNT_ID:'a'.repeat(32)};
 assert.equal((await runT016('t016-r2-off',env)).failure,'reviewed-runtime-unconfigured');
 const images=Object.fromEntries(['controller','build','browser'].map(role=>[role,'ghcr.io/runeditrun/t016-'+role+'@sha256:'+'a'.repeat(64)]));
 for(const [role,value] of Object.entries(images))env['T016_'+role.toUpperCase()+'_IMAGE']=value;
 assert.equal((await runT016('t016-r2-off',env)).failure,'isolation-unqualified');
 assert.notEqual(isolationAttestation(images,'a'.repeat(40)),isolationAttestation(images,'b'.repeat(40)));
}]);
evidenceRows.push(['evidence binds isolation to the exact reviewed images and controller', {}, async()=>{
 const report=await runT016('t016-r2-off',{}), controllerSha='a'.repeat(40);
 const images={controller:'sha256:'+'1'.repeat(64),build:'sha256:'+'2'.repeat(64),browser:'sha256:'+'3'.repeat(64)};
 const facts={controllerSha,attestation:isolationAttestation(images,controllerSha),controllerImage:images.controller,buildImage:images.build,browserImage:images.browser};
 validateQualification({...report,observations:[observation('isolation',facts),...report.observations]},report.proof);
 assert.throws(()=>validateQualification({...report,observations:[observation('isolation',{...facts,buildImage:'sha256:'+'4'.repeat(64)}),...report.observations]},report.proof),/isolation-provenance/);
 assert.deepEqual(runtimeImages({T016_CONTROLLER_IMAGE:images.controller,T016_BUILD_IMAGE:images.build,T016_BROWSER_IMAGE:images.browser}),images);
}]);
isolationRows.push(['sandbox flags and Docker environment expose neither parent secrets nor host namespaces', {}, ()=>{
 const env=dockerEnvironment({PATH:'/bin',HOME:'/safe',RUNNER_TEMP:'/scratch',CF_THROWAWAY_API_TOKEN:'test-only',EVIDENCE_WRITE_TOKEN:'test-only'});
 assert(!JSON.stringify(env).includes('test-only'));
 assert(isolationFlags.includes('--read-only'));assert(isolationFlags.includes('--cap-drop=ALL'));
 assert(!isolationFlags.some(flag=>/privileged|pid=host|network=host/.test(flag)));
}]);
deploymentRows.push(['newer unrelated Cloudflare versions cannot satisfy a deployment receipt', {}, async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 globalThis.fetch=async()=>Response.json({success:true,result:{deployments:[{id:'deployment-id',versions:[{version_id:'11111111-1111-1111-1111-111111111111',percentage:100}]}]}});
 await assert.rejects(deploymentIdentity({CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only',H2H_RESOURCE_PREFIX:'t016-1-1'},
  {output:'Current Version ID: 22222222-2222-2222-2222-222222222222',artifact:{},stage:'initial'}),/deployment-readback-failed/);
}]);
deploymentRows.push(['serving version is bound to exact module and static asset bytes, with race rejection', {}, async t=>{
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
}]);

test("artifact and deployment custody bind exact inert bytes and resource configuration", async t => {
  await runRows(t, [...artifactRows, ...deploymentRows, ...strictUnpackerRows])
})

test("qualification authority and evidence require explicit review and exact provenance", async t => {
  await runRows(t, [...evidenceRows, ...isolationRows])
})
