import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {adoptEditor} from './dependency-editor.mjs';
import {fixture,freePort} from './reference.mjs';
import {testProvider} from '../../default-seed/tests/operator-auth/oidc-provider.mjs';
import {labels} from '../../onboarding/adapter-labels.mjs';
import {useWorkspaceDependencies} from './workspace-dependencies.mjs';

export function setupDiagnostic(child) {
 // Emit fixed classifications only; child messages and private values stay local.
 const events=new Set(['error','result','waiting','setup-ready']);
 const codes=new Set(['invalid_invocation','invalid_setup_manifest','missing_input','safety_refusal','command_failed','cancelled']);
 const reasons=[['setup_fields',/^Missing or invalid active setup fields:/],['provider_document',/^A selected provider dependency document is unavailable\.$/],['approval_scope',/^Link approval must name this exact origin,/],['approval_required',/^Provider approval is required\./],['pnpm_probe',/^The pinned pnpm version probe failed\./]];
 const rows=[];
 for(const line of child.stdoutText.split('\n')) {
  let row;try{row=JSON.parse(line);}catch{continue;}
  if(!row || !events.has(row.event))continue;
  const reason=typeof row.message==='string'?reasons.find(([,pattern])=>pattern.test(row.message))?.[0]:undefined;
  rows.push({event:row.event,...(codes.has(row.code)?{code:row.code}:{}),...(reason?{reason}:{}),...(Number.isInteger(row.exitCode)&&row.exitCode>=0&&row.exitCode<=255?{exitCode:row.exitCode}:{})});
 }
 const lines=new Set(child.stderrText.split('\n').map(line=>line.trim()));
 const steps=Object.entries(labels).filter(([,label])=>lines.has(label)).map(([step])=>step);
 return {events:rows,steps};
}

// A seed checked out, wired to a controlled Auth provider and set up once:
// the shared start of every linked-dependency journey. Returns the fixture, the
// provider and its approvals, the command line and environment of `rer setup`,
// and `state`, which the controlled provider edge reads on every request.
export async function linkedSetup(kind,t) {
 const f=await fixture(kind,t),origin='http://127.0.0.1:'+await freePort(),provider=await testProvider(origin,'cli-owner@example.test');
 await adoptEditor(f.root,kind);
 if(kind==='foundation') {const path=join(f.root,'rer-setup.json'),manifest=JSON.parse(await readFile(path,'utf8'));manifest.steps=manifest.steps.map(step=>step.type==='owner-claim'?{type:'owner-claim',mode:'idp',emailField:'OWNER_EMAIL',dependency:'oidc-provider@1',path:'/auth/owner-claim'}:step);await writeFile(path,JSON.stringify(manifest));}
 await useWorkspaceDependencies(f.root);
 // An exported checkout has no repository yet. Provenance checking still uses
 // real Git, and the approval remains an untracked, owner-only file.
 execFileSync('git',['init','--quiet',f.root]);
 const contracts=kind==='default-seed'?['oidc-provider@1','error-sink@1']:['oidc-provider@1'];
 if(kind==='default-seed') {
  const path=join(f.root,'rer-setup.json'),manifest=JSON.parse(await readFile(path,'utf8'));
  manifest.fields.push({name:'ERROR_PROVIDER',kind:'url',label:'Error provider',required:false});manifest.dependencies.push({interface:'error-sink@1',optional:true,cardinality:1,address:'ERROR_PROVIDER',paths:['/errors/callback']});await writeFile(path,JSON.stringify(manifest));
  const auth=join(f.root,'src/core/platform/auth/dependencies.server.ts');let source=await readFile(auth,'utf8');source=source.replace('const response = await createDependencies(options).handle(request)',`const response = await createDependencies({...options,interfaces:[{interface:'oidc-provider@1',provider:env.IDENTITY_PROVIDER,paths:['/auth/oidc/auth/callback','/auth/oidc/auth/logout']},{interface:'error-sink@1',provider:env.IDENTITY_PROVIDER,paths:['/errors/callback']}]}).handle(request)`);await writeFile(auth,source);
 }
 const callbacks=[origin+'/.well-known/rer-link/callback',origin+'/auth/oidc/auth/callback',origin+'/auth/oidc/auth/logout'];
 const issuedAt=Date.now(); // One instant keeps the approval within its one-hour bound.
 const token={token:crypto.randomUUID(),issuer:provider.issuer,interface:'oidc-provider@1',origin,callbacks,issuedAt,expiresAt:issuedAt+3600000};const approvals=new Map(contracts.map(contract=>[contract,{...token,token:crypto.randomUUID(),interface:contract,callbacks:contract==='oidc-provider@1'?callbacks:[origin+'/.well-known/rer-link/callback',origin+'/errors/callback']} ]));const used=new Set();const state={expectedClaim:kind==='foundation',offline:false,unavailable:false},edge=[];
 const server=createServer(async(req,res)=>{
  try {
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const path=new URL(req.url,'http://local').pathname;let response;
   if(state.unavailable && ['/.well-known/openid-configuration','/jwks','/remove'].includes(path))response=Response.json({error:'unavailable'},{status:404});
   else if(state.offline && path==='/.well-known/rer-provider')response=Response.json({error:'offline'},{status:503});
   else if(path==='/.well-known/rer-dependencies')response=Response.json({origin:provider.issuer,version:1,provides:contracts,dependencies:[]});
   else if(path==='/link') {
    const data=JSON.parse(Buffer.concat(chunks).toString());
    if(used.has(data.interface)||data.token!==approvals.get(data.interface)?.token||data.origin!==origin)response=Response.json({error:'invalid_token'},{status:403});
    else {
     // The app's native bootstrap must already have committed when Auth pulls.
     const document=await (await fetch(origin+'/.well-known/rer-dependencies')).json();assert.equal(document.claim,state.expectedClaim);used.add(data.interface);
     response=await provider.link((path,{method='GET',input}={})=>fetch(origin+path,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})}),data.interface);
    }
   } else response=await provider.fetch(new Request(provider.issuer+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}));
   edge.push({path,status:response.status,...(response.status>=400?{error:await response.clone().json().catch(()=>({}))}:{})});
   const headers=new Headers(response.headers);for(const name of ['content-encoding','content-length','transfer-encoding'])headers.delete(name);res.writeHead(response.status,Object.fromEntries(headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){edge.push({error:error.message});res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 await writeFile(join(f.root,'answers.json'),JSON.stringify({OWNER_EMAIL:'cli-owner@example.test',IDENTITY_PROVIDER:provider.issuer,...(kind==='default-seed'?{ERROR_PROVIDER:provider.issuer}:{}),...(kind==='foundation'?{WORKSPACE_TITLE:'Linked workspace',CONNECTION_PASSWORD:'local-fixture-private-value'}:{})}),{mode:0o600});
 const approvalFiles=Object.fromEntries(contracts.map((contract,i)=>[contract,`approval-${i}.json`]));
 const writeApprovals=async()=>{for(const [contract,value] of approvals)await writeFile(join(f.root,approvalFiles[contract]),JSON.stringify(value),{mode:0o600});};
 await writeApprovals();
 const env={NODE_OPTIONS:'--import '+resolve('cli/fixtures/provider-network.mjs'),AUTH_TEST_EDGE:'http://127.0.0.1:'+server.address().port,RER_LINK_TOKEN_FILE:'',RER_LINK_TOKEN_FILES:JSON.stringify(approvalFiles)};
 const args=['scripts/rer.mjs','setup','--answers','answers.json','--non-interactive','--json','--no-queue','--port',new URL(origin).port];
 if(kind==='foundation') {const pending=f.launch(args,process.execPath,env);assert.equal(await pending.done,3,'pending setup command has the expected outcome');assert.equal((await f.sql('SELECT count(*) n FROM oa_operators'))[0].results[0].n,0);provider.allowOwnerClaim();used.clear();for(const value of approvals.values())value.token=crypto.randomUUID();await writeApprovals();}
 const first=f.launch(args,process.execPath,env),firstCode=await first.done;
 if(firstCode!==0)t.diagnostic(JSON.stringify(setupDiagnostic(first)));
 assert.equal(firstCode,0,'first setup command has the expected outcome');assert.deepEqual([...used].sort(),contracts.slice().sort());state.expectedClaim=false;for(const file of Object.values(approvalFiles))await assert.rejects(access(join(f.root,file)));
 const saved=await readFile(join(f.root,'.seed/installer/setup-answers.json'),'utf8');for(const value of approvals.values())assert.equal(saved.includes(value.token),false);
 return {f,origin,provider,contracts,approvals,approvalFiles,used,state,edge,env,args,writeApprovals};
}
