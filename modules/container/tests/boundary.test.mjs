import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,access,realpath} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {checkBoundary} from '../boundary.mjs';
import {buildContainer} from '../build.mjs';

async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rer-container-boundary-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'src'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');await writeFile(join(root,'wrangler.jsonc'),JSON.stringify({main:'src/server.ts'}));await writeFile(join(root,'src/server.ts'),"import './product';");await writeFile(join(root,'src/product.ts'),'export {};');await symlink(resolve(import.meta.dirname,'../../../default-seed/node_modules'),join(root,'node_modules'));
 return root;
}
async function workerdOnly(root,source) {
 await writeFile(join(root,'src/product.ts'),source);
 assert.deepEqual(await checkBoundary(root,{engine:'workerd'}),{engine:'workerd',ok:true});
 await assert.rejects(checkBoundary(root,{engine:'node'}),/import boundary/);
 await assert.rejects(checkBoundary(root),/import boundary/);
}
test('container admission rejects Cloudflare imports and APIs outside the platform boundary',async t=>{
 const root=await fixture(t);
 await mkdir(join(root,'src/core/platform'),{recursive:true});
 await writeFile(join(root,'src/core/platform/bindings.server.ts'),"import {env as bindings} from 'cloudflare:workers';export {bindings};");
 await writeFile(join(root,'src/server.ts'),"import './core/platform/bindings.server'; import './product';");
 await checkBoundary(root);
 await writeFile(join(root,'src/core/platform/bindings-copy.server.ts'),"import {env as bindings} from 'cloudflare:workers';export {bindings};");
 await writeFile(join(root,'src/server.ts'),"import './core/platform/bindings-copy.server'; import './product';");
 await assert.rejects(checkBoundary(root),error=>error.failures.some(failure=>failure.path==='src/core/platform/bindings-copy.server.ts'));
 await writeFile(join(root,'src/server.ts'),"import './core/platform/bindings.server'; import './product';");
 for(const source of ["import * as native from 'cloudflare:workers';", "export {DurableObject} from 'cloudflare:workers';", "const native=await import('cloudflare:workers');", "const ws=new WebSocketPair();", "const cache=caches['default'];"]){await writeFile(join(root,'src/product.ts'),source);await assert.rejects(checkBoundary(root),/import boundary/);}
});
test('the boundary admits an exported seed\'s demo guard and no other file or import like it',async t=>{
 const root=await fixture(t);
 await mkdir(join(root,'src/modules/demo'),{recursive:true});
 const guard="import { env } from 'cloudflare:workers';export const on=env.RER_DEMO==='1';";
 const demo=join(root,'src/modules/demo/index.mjs');
 await writeFile(demo,guard);await writeFile(join(root,'src/server.ts'),"import './modules/demo/index.mjs';");await checkBoundary(root);
 for(const path of ['src/product.ts','src/modules/demo/sockets.mjs','src/app/modules/demo/index.mjs','src/src/modules/demo/index.mjs']){
  await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),guard);
  const entry=relative(join(root,'src'),join(root,path)).split('\\').join('/');
  await writeFile(join(root,'src/server.ts'),`import './${entry}';`);
  await assert.rejects(checkBoundary(root),error=>error.failures.some(failure=>failure.path.split('\\').join('/')===path));await rm(join(root,path));
 }
 await writeFile(join(root,'src/server.ts'),"import './modules/demo/index.mjs';");
 for(const source of ["import { env as bindings } from 'cloudflare:workers';","import { env, DurableObject } from 'cloudflare:workers';","import workers, { env } from 'cloudflare:workers';","export { env } from 'cloudflare:workers';","import { env } from 'cloudflare:sockets';"]){await writeFile(demo,source);await assert.rejects(checkBoundary(root),/import boundary/);}
});

test('container admission permits HTMLRewriter only for workerd and keeps other API boundaries',async t=>{
 const root=await fixture(t);
 await writeFile(join(root,'src/product.ts'),'export const rewrite = response => new HTMLRewriter().transform(response);');
 assert.deepEqual(await checkBoundary(root,{engine:'workerd'}),{engine:'workerd',ok:true});
 const htmlBoundary=error=>error.failures?.some(failure=>failure.api==='HTMLRewriter');
 await assert.rejects(checkBoundary(root,{engine:'node'}),htmlBoundary);
 await assert.rejects(checkBoundary(root),htmlBoundary);
 for(const source of ["email(message);","caches.default;","request.cf;","caches['default'];","request['cf'];","import {connect} from 'cloudflare:sockets';","export * from 'cloudflare:sockets';","await import('cloudflare:sockets');","require('cloudflare:workers');","import workers = require('cloudflare:workers');"]){
  await writeFile(join(root,'src/product.ts'),source);
  for(const engine of ['workerd','node'])await assert.rejects(checkBoundary(root,{engine}),/import boundary/);
 }
});

test('container boundary follows reachable source and fresh output graphs, leaving dormant source alone',async t=>{
 const root=await fixture(t);
 await rm(join(root,'wrangler.jsonc'));
 await writeFile(join(root,'wrangler.toml'),'name = "reachable-boundary"\nmain = "./src/server.ts"\n');
 await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{module:'ESNext',moduleResolution:'Bundler',baseUrl:'.',paths:{'@app/*':['src/*']}}}));
 await mkdir(join(root,'src/cycle'),{recursive:true});await mkdir(join(root,'src/settings'),{recursive:true});await mkdir(join(root,'src/modules/egress-service'),{recursive:true});
 await writeFile(join(root,'src/server.ts'),"import {loop} from './cycle/a'; export {default as settings} from '@app/settings'; const runtime=require('./runtime'); void import('./lazy'); export const ready=loop+runtime;");
 await writeFile(join(root,'src/cycle/a.ts'),"export {loop} from './b'; export const started=true;");
 await writeFile(join(root,'src/cycle/b.ts'),"import './a'; export const loop=1;");
 await writeFile(join(root,'src/settings/index.ts'),"export default 'ready';");
 await writeFile(join(root,'src/runtime.ts'),"export default 1;");
 await writeFile(join(root,'src/lazy.ts'),"export const value='lazy';");
 await writeFile(join(root,'src/erased.ts'),"export type Marker=string; new WebSocketPair();");
 await writeFile(join(root,'src/type-only.ts'),"import type {Marker} from './erased'; export type {Marker};");
 await writeFile(join(root,'src/modules/egress-service/worker.ts'),"import {connect} from 'cloudflare:sockets'; export class Egress extends DurableObject { connect=connect; pair=new WebSocketPair(); }");
 await writeFile(join(root,'src/dormant.ts'),"export const rewrite=new HTMLRewriter();");
 await writeFile(join(root,'src/server.ts'),"import './type-only'; import {loop} from './cycle/a'; export {default as settings} from '@app/settings'; const runtime=require('./runtime'); void import('./lazy'); export const ready=loop+runtime;");
 assert.deepEqual(await checkBoundary(root,{engine:'node'}),{engine:'node',ok:true});
 await writeFile(join(root,'src/server.ts'),"import './missing';");
 await assert.rejects(checkBoundary(root,{engine:'node'}),error=>error.failures.some(failure=>failure.api==='Unresolved local runtime import'&&failure.specifier==='./missing'));
 await writeFile(join(root,'src/server.ts'),"import '@app/missing';");
 await assert.rejects(checkBoundary(root,{engine:'node'}),error=>error.failures.some(failure=>failure.api==='Unresolved local runtime import'&&failure.specifier==='@app/missing'));
 await writeFile(join(root,'src/source-helper.ts'),"export const ready=true;");
 for(const [runtime,source,declaration] of [['.mjs','.mts','.d.mts'],['.js','.ts','.d.ts'],['.cjs','.cts','.d.cts']]){
  const stem='src/runtime-pair', runtimePath=stem+runtime, sourcePath=stem+source;
  await writeFile(join(root,stem+declaration),'export declare const ready:boolean;');
  await writeFile(join(root,sourcePath),"export {ready} from '@app/source-helper.js';");
  for(const specifier of [`./runtime-pair${runtime}`,`@app/runtime-pair${runtime}`]){
   await writeFile(join(root,runtimePath),"require('./source-helper.js');");
   await writeFile(join(root,'src/server.ts'),`import '${specifier}';`);
   assert.deepEqual(await checkBoundary(root,{engine:'node'}),{engine:'node',ok:true});
   await writeFile(join(root,runtimePath),"new WebSocketPair(); require('cloudflare:sockets');");
   for(const engine of ['node','workerd'])await assert.rejects(checkBoundary(root,{engine}),error=>error.failures.some(failure=>failure.path===runtimePath&&failure.api==='Dynamic Cloudflare import'));
  }
  await rm(join(root,runtimePath));
  assert.deepEqual(await checkBoundary(root,{engine:'node'}),{engine:'node',ok:true});
  await writeFile(join(root,sourcePath),'new WebSocketPair();');
  await assert.rejects(checkBoundary(root,{engine:'node'}),error=>error.failures.some(failure=>failure.path===sourcePath&&failure.api==='WebSocketPair'));
  await rm(join(root,sourcePath));
  for(const specifier of [`./runtime-pair${runtime}`,`@app/runtime-pair${runtime}`,`./runtime-pair${declaration}`,`@app/runtime-pair${declaration}`]){
   await writeFile(join(root,'src/server.ts'),`import '${specifier}';`);
   await assert.rejects(checkBoundary(root,{engine:'node'}),error=>error.failures.some(failure=>failure.api==='Unresolved local runtime import'&&failure.specifier===specifier));
  }
  await rm(join(root,stem+declaration));
 }
 await writeFile(join(root,'src/server.ts'),"import './type-only'; import {loop} from './cycle/a'; export {default as settings} from '@app/settings'; const runtime=require('./runtime'); void import('./lazy'); export const ready=loop+runtime;");

 const server=join(root,'dist/server'), chunks=join(server,'chunks');
 await mkdir(chunks,{recursive:true});
 const output={
  'index.mjs':"import './chunks/start.mjs'; export {value} from './chunks/value'; const runtime=require('./required'); void import('./lazy'); export const ready=runtime;",
  'chunks/start.mjs':"import './back.mjs'; export const start=true;",
  'chunks/back.mjs':"import './start.mjs'; export const back=true;",
  'chunks/value.mjs':"export const value=1;",
  'required.mjs':"export default 1;",
  'lazy.mjs':"export const lazy=true;",
  'stale.mjs':"export const stale=new WebSocketPair();",
 };
 for(const [name,source] of Object.entries(output))await writeFile(join(server,name),source);
 const emitted=new Set(Object.keys(output).filter(name=>name!=='stale.mjs').map(name=>join(server,name)));
 assert.deepEqual(await checkBoundary(root,{engine:'node',entries:['dist/server/index.mjs'],emittedFiles:emitted,outputRoot:server}),{engine:'node',ok:true});

 await writeFile(join(server,'lazy.mjs'),"export const lazy=new WebSocketPair();");
 await assert.rejects(checkBoundary(root,{engine:'node',entries:['dist/server/index.mjs'],emittedFiles:emitted,outputRoot:server}),error=>error.failures.some(failure=>failure.path==='dist/server/lazy.mjs'&&failure.api==='WebSocketPair'));
 await writeFile(join(server,'lazy.mjs'),output['lazy.mjs']);
 await writeFile(join(server,'index.mjs'),output['index.mjs'].replace("import './chunks/start.mjs';","import './stale.mjs'; import './chunks/start.mjs';"));
 await assert.rejects(checkBoundary(root,{engine:'node',entries:['dist/server/index.mjs'],emittedFiles:emitted,outputRoot:server}),error=>error.failures.some(failure=>failure.path==='dist/server/index.mjs'&&failure.message==='local import was not emitted by this build'));
});

test('ordinary calls with cloudflare strings are not module imports',async t=>{
 const root=await fixture(t);
 await writeFile(join(root,'src/product.ts'),"const predicate=specifier=>specifier.startsWith('cloudflare:'); label('cloudflare:workers'); load('cloudflare:workers'); export {predicate};");
 assert.deepEqual(await checkBoundary(root,{engine:'node'}),{engine:'node',ok:true});
 assert.deepEqual(await checkBoundary(root,{engine:'workerd'}),{engine:'workerd',ok:true});
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
 await writeFile(join(root,'src/server.ts'),"import './platform/blobs/snapshot-cache';");
 await checkBoundary(root,{engine:'node',cacheContract:'lamp-retained-v1'});
 await checkBoundary(root,{cacheContract:'lamp-retained-v1'});
 await assert.rejects(checkBoundary(root),/import boundary/);
 await writeFile(join(root,'src/platform/blobs/snapshot-cache-adjacent.ts'),"import {DurableObject} from 'cloudflare:workers'; export class SnapshotCache extends DurableObject {}");
 await writeFile(join(root,'src/server.ts'),"import './platform/blobs/snapshot-cache-adjacent';");
 await assert.rejects(checkBoundary(root,{engine:'node',cacheContract:'lamp-retained-v1'}),error=>error.failures.some(failure=>failure.path==='src/platform/blobs/snapshot-cache-adjacent.ts'));
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
