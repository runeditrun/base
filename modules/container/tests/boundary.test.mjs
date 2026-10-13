import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
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
