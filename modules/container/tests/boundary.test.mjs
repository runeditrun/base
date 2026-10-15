import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {checkBoundary} from '../boundary.mjs';
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
  for(const source of ["new WebSocketPair();","passThroughOnException();","timingSafeEqual(a,b);","email(message);","caches.default;","request.cf;","import {env} from 'cloudflare:workers';","await import('cloudflare:workers');","class Cache extends DurableObject {}"]){
   await writeFile(join(root,'src/product.ts'),source);
   for(const engine of ['workerd','node'])await assert.rejects(checkBoundary(root,{engine}),/import boundary/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
