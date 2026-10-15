import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,cp,access,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {checkBoundary} from '../boundary.mjs';
import {buildContainer} from '../build.mjs';

async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-container-boundary-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'src'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
 return root;
}
async function workerdOnly(root,source) {
 await writeFile(join(root,'src/product.ts'),source);
 assert.deepEqual(await checkBoundary(root,{engine:'workerd'}),{engine:'workerd',ok:true});
 await assert.rejects(checkBoundary(root,{engine:'node'}),/import boundary/);
 await assert.rejects(checkBoundary(root),/import boundary/);
}
test('container admission rejects Cloudflare imports and APIs outside the platform boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rer-container-boundary-'));
 try{
  await mkdir(join(root,'src/core/platform'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
  await writeFile(join(root,'src/core/platform/bindings.server.ts'),"import {env as bindings} from 'cloudflare:workers';export {bindings};");await checkBoundary(root);
  for(const source of ["import * as native from 'cloudflare:workers';", "export {DurableObject} from 'cloudflare:workers';", "const native=await import('cloudflare:workers');", "const ws=new WebSocketPair();", "const cache=caches['default'];"]){await writeFile(join(root,'src/product.ts'),source);await assert.rejects(checkBoundary(root),/import boundary/);}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('the boundary admits an exported seed\'s demo guard and no other file or import like it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rer-container-boundary-'));
 try{
  await mkdir(join(root,'src/modules'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
  await cp(resolve(import.meta.dirname,'../../demo'),join(root,'src/modules/demo'),{recursive:true});await checkBoundary(root);
  const guard="import { env } from 'cloudflare:workers';export const on=env.RER_DEMO==='1';";
  for(const path of ['src/product.ts','src/modules/demo/sockets.mjs','src/app/modules/demo/index.mjs','src/src/modules/demo/index.mjs']){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),guard);await assert.rejects(checkBoundary(root),error=>error.failures.some(failure=>failure.path.split('\\').join('/')===path));await rm(join(root,path));}
  for(const source of ["import { env as bindings } from 'cloudflare:workers';","import { env, DurableObject } from 'cloudflare:workers';","import workers, { env } from 'cloudflare:workers';","export { env } from 'cloudflare:workers';","import { env } from 'cloudflare:sockets';"]){await writeFile(join(root,'src/modules/demo/index.mjs'),source);await assert.rejects(checkBoundary(root),/import boundary/);}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('container admission permits HTMLRewriter only for workerd and keeps other API boundaries',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rer-container-engine-'));
 try{
  await mkdir(join(root,'src'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
  await writeFile(join(root,'src/product.ts'),'export const rewrite = response => new HTMLRewriter().transform(response);');
  assert.deepEqual(await checkBoundary(root,{engine:'workerd'}),{engine:'workerd',ok:true});
  const htmlBoundary=error=>error.failures?.some(failure=>failure.api==='HTMLRewriter');
  await assert.rejects(checkBoundary(root,{engine:'node'}),htmlBoundary);
  await assert.rejects(checkBoundary(root),htmlBoundary);
  for(const source of ["email(message);","caches.default;","request.cf;","caches['default'];","request['cf'];","import {connect} from 'cloudflare:sockets';","export * from 'cloudflare:sockets';","await import('cloudflare:sockets');","require('cloudflare:workers');","load('cloudflare:workers');"]){
   await writeFile(join(root,'src/product.ts'),source);
   for(const engine of ['workerd','node'])await assert.rejects(checkBoundary(root,{engine}),/import boundary/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('workerd admits exact workers imports and re-exports while Node retains its contracts',async t=>{
 const root=await fixture(t);
 for(const source of [
  "import {env} from 'cloudflare:workers'; export const value=env.VALUE;",
  "import * as workers from 'cloudflare:workers'; export const value=workers.env.VALUE;",
  "import 'cloudflare:workers';",
  "export {DurableObject} from 'cloudflare:workers';",
  "export * from 'cloudflare:workers';",
  "export const bindings=await import('cloudflare:workers');",
 ])await workerdOnly(root,source);
 await rm(join(root,'src/product.ts'));
 await mkdir(join(root,'src/platform/blobs'),{recursive:true});
 await writeFile(join(root,'src/platform/blobs/snapshot-cache.ts'),"import {DurableObject} from 'cloudflare:workers'; export class SnapshotCache extends DurableObject {}");
 await checkBoundary(root,{engine:'node',cacheContract:'lamp-retained-v1'});
 await checkBoundary(root,{cacheContract:'lamp-retained-v1'});
 await assert.rejects(checkBoundary(root),/import boundary/);
});

test('workerd admits Durable Object definitions and builds only local exported bindings',async t=>{
 const root=await fixture(t);
 for(const source of [
  "import {DurableObject} from 'cloudflare:workers'; export class Counter extends DurableObject {}",
  "import {DurableObject as Base} from 'cloudflare:workers'; export class Counter extends Base {}",
  "import * as workers from 'cloudflare:workers'; export class Counter extends workers.DurableObject {}",
  "import * as workers from 'cloudflare:workers'; export class Counter extends workers['DurableObject'] {}",
  "import {DurableObject} from 'cloudflare:workers'; class Internal extends DurableObject {} export {Internal as Counter};",
  "import {DurableObject} from 'cloudflare:workers'; class BaseCounter extends DurableObject {} export class Counter extends BaseCounter {}",
  "const {DurableObject}=await import('cloudflare:workers'); export class Unbound extends DurableObject {}",
  "class NotADurableObject {} class Unrelated extends NotADurableObject {}",
  "class Unbound extends DurableObject {}",
 ])await workerdOnly(root,source);
 // Build through the real Vite/Cloudflare pipeline. Names in source need not
 // match configured exports, and an unbound base class needs no declaration.
 await writeFile(join(root,'vite.config.mjs'),`
  import {cloudflare} from '@cloudflare/vite-plugin';
  export default {
   logLevel:'silent', plugins:[cloudflare({viteEnvironment:{name:'ssr'}})],
   environments:{ssr:{build:{outDir:'dist/server'}}},
   builder:{buildApp:async builder=>{await builder.build(builder.environments.ssr);}},
  };
 `);
 const config={name:'container-boundary',main:'src/product.ts',compatibility_date:'2026-09-01',migrations:[{tag:'v1',new_sqlite_classes:['Counter']}],durable_objects:{bindings:[{name:'COUNTER',class_name:'Counter'}]}};
 const source="import {BaseCounter} from './counter'; class Internal extends BaseCounter {} export {Internal as Counter}; export default {fetch() { return new Response('ok'); }};";
 await writeFile(join(root,'src/counter.ts'),"import {DurableObject} from 'cloudflare:workers'; export class BaseCounter extends DurableObject {fetch() { return new Response('counter'); }}");
 await writeFile(join(root,'src/product.ts'),source);
 const build=output=>buildContainer(root,{engine:'workerd',declaration:{},output:join(root,output)});
 const configure=extra=>writeFile(join(root,'wrangler.jsonc'),JSON.stringify({...config,durable_objects:{bindings:[{...config.durable_objects.bindings[0],...extra}]}}));
 await configure({});
 const result=await build('image');
 await access(join(result.output,'app',result.manifest.entry));
 t.diagnostic('Packaged real Vite Worker with Counter export alias and imported base class');
 await writeFile(join(root,'src/product.ts'),source.replace('export {Internal as Counter};',''));
 await assert.rejects(build('missing-image'),error=>{assert.match(error.message,/does not export configured Durable Object class: Counter/);t.diagnostic(error.message);return true;});
 await assert.rejects(access(join(root,'missing-image')), {code:'ENOENT'});
 await writeFile(join(root,'src/product.ts'),source);
 for(const extra of [{script_name:'other-worker'},{script_name:'other-worker',environment:'production'}]) {
  await configure(extra);
  await assert.rejects(build('external-image'),error=>{assert.match(error.message,/script_name or environment/);t.diagnostic(error.message);return true;});
  await assert.rejects(access(join(root,'external-image')), {code:'ENOENT'});
 }
});

test('workerd admits WebSocketPair while Node refuses it',async t=>{
 await workerdOnly(await fixture(t),'export function pair() { return new WebSocketPair(); }');
});

test('workerd admits crypto.subtle.timingSafeEqual while Node refuses it',async t=>{
 await workerdOnly(await fixture(t),'export function equal(a,b) { return crypto.subtle.timingSafeEqual(a,b); }');
});

test('workerd admits ctx.passThroughOnException while Node refuses it',async t=>{
 await workerdOnly(await fixture(t),'export default { fetch(request,env,ctx) { ctx.passThroughOnException(); return new Response("ok"); } };');
});
