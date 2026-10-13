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
