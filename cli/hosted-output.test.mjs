import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

// A built seed whose Worker only routes app paths, the way Start entries did before
// serving assets; `adopted` serves built files and the deploy identity as Base asks.
const worker=adopted=>`export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 ${adopted?"if(request.method==='GET'&&/\\.[a-z0-9]+$/.test(path)){const asset=await env.ASSETS.fetch(request);if(asset.status!==404)return asset;}":''}
 if(path==='/health')return Response.json(${adopted?'{ok:true,deployment:{sourceSha:env.RER_DEPLOY_SOURCE,fingerprint:env.RER_DEPLOY_FINGERPRINT,versionId:env.RER_VERSION.id}}':"{status:'ok'}"});
 return new Response('<link rel="stylesheet" href="/theme.css">',{status:path==='/'?200:404,headers:{'content-type':'text/html'}});
}}`;
async function seed(t,adopted){
 const root=await mkdtemp(join(tmpdir(),'rer-hosted-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'dist/server'),{recursive:true});await mkdir(join(root,'dist/client/assets'),{recursive:true});
 // The seed's own wrangler (and its Miniflare) serves the build.
 await symlink(resolve(import.meta.dirname,'../default-seed/node_modules'),join(root,'node_modules'));
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'deploy.json'),'{"version":1,"vars":{}}');
 await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',compatibility_date:'2026-09-08',assets:{directory:'../client'}}));
 await writeFile(join(root,'dist/server/index.js'),worker(adopted));
 await writeFile(join(root,'dist/client/assets/app-1.js'),'console.log(1)');
 await writeFile(join(root,'dist/client/theme.css'),'body{}');
 await writeFile(join(root,'dist/client/.assetsignore'),'wrangler.json');
 return root;
}

test('verify fails plainly when the hosted Worker would 404 its built files or omit its deploy identity, and passes once it serves them',async t=>{
 const packageRoot=await mkdtemp(join(tmpdir(),'rer-pnpm-entry-'));
 t.after(()=>rm(packageRoot,{recursive:true,force:true}));
 await mkdir(join(packageRoot,'node_modules/@runeditrun'),{recursive:true});
 await symlink(resolve(import.meta.dirname,'..'),join(packageRoot,'node_modules/@runeditrun/rer'));
 const entry=join(packageRoot,'node_modules/@runeditrun/rer/cli/hosted-output.mjs');
 const failing=await run(process.execPath,[entry,await seed(t,false)]).then(()=>null,error=>error);
 assert.equal(failing?.code,1);
 assert.match(failing.stderr,/404 \/assets\/app-1\.js/);
 assert.match(failing.stderr,/404 \/theme\.css/);
 assert.match(failing.stderr,/\/health lacks the deploy identity/);
 assert.doesNotMatch(failing.stderr,/assetsignore/);
 const passing=await run(process.execPath,[entry,await seed(t,true)]);
 assert.equal(JSON.parse(passing.stdout).assets,2);
 const hydration=await run(process.execPath,[join(packageRoot,'node_modules/@runeditrun/rer/cli/hydration/check.mjs'),packageRoot]).then(()=>null,error=>error);
 assert.equal(hydration?.code,1,'the symlinked hydration command refuses an absent build');
 assert.ok(hydration.stderr.trim(),'the check reports its failure instead of silently returning');
});

test('hosted mail uses declared Managed credentials without concealing missing own-host secrets',async t=>{
 const root=await seed(t,true),entry=resolve(import.meta.dirname,'hosted-output.mjs');
 const declaration={vars:{MAIL_FROM:'sender@example.com'},secrets:[{binding:'MAIL_PROVIDER',verifyStandIn:'resend'}]};
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 await writeFile(join(root,'rer-setup.json'),JSON.stringify({fields:[{name:'MAIL_PROVIDER',default:'development'}]}));
 await writeFile(join(root,'dist/server/index.js'),worker(true).replace("if(path==='/health')",`if(path==='/health'&&(!env.MAIL_FROM||!(env.MAIL_PROVIDER==='rer'?env.MAIL_API_KEY&&env.MAIL_RELAY_URL:env.MAIL_PROVIDER==='resend'&&env.MAIL_PROVIDER_API_KEY)))return Response.json({ok:false},{status:503});
 if(path==='/health'&&env.REQUIRE_SESSION&&!env.SESSION_SECRET)return Response.json({ok:false},{status:503});
 if(path==='/health')`));
 const check=()=>run(process.execPath,[entry,root]);
 const fails=async()=>{const error=await check().then(()=>null,error=>error);assert.equal(error?.code,1);assert.match(error.stderr,/HTTP 503/);};
 // Own-host cannot obtain an undeclared credential from setup or ambient env.
 await fails();
 const spec={mail:{providers:['rer']},optionalSecretNames:['MAIL_API_KEY','MAIL_PROVIDER_API_KEY','SESSION_SECRET']};
 await writeFile(join(root,'packaging.json'),JSON.stringify({artifact:{specInputs:spec}}));
 assert.equal(JSON.parse((await check()).stdout).health,'identity');
 // The Managed provider uses its own declared key, too.
 declaration.vars={MAIL_PROVIDER:'rer',MAIL_FROM:'sender@example.com',MAIL_RELAY_URL:'https://mail.example.invalid/relay'};
 declaration.secrets=[];
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 assert.equal(JSON.parse((await check()).stdout).health,'identity');
 // A mail capability cannot invent unrelated application secrets.
 declaration.vars.REQUIRE_SESSION=true;
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 await fails();
 declaration.vars.REQUIRE_SESSION=false;
 declaration.vars.MAIL_PROVIDER='resend';
 spec.mail.providers=['resend'];
 await writeFile(join(root,'packaging.json'),JSON.stringify({artifact:{specInputs:spec}}));
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 await fails();
 declaration.secrets=[{binding:'MAIL_PROVIDER_API_KEY',verifyStandIn:'test-own-host-mail-key'}];
 await writeFile(join(root,'deploy.json'),JSON.stringify(declaration));
 assert.equal(JSON.parse((await check()).stdout).health,'identity');
});
