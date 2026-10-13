import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertInstaller } from '../lib/acquire.mjs';
test('lowercase authoritative seed identity is accepted; mismatched metadata is refused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rer-lowercase-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'scripts'));await writeFile(join(root,'scripts/install.mjs'),'// test identity only');
 await writeFile(join(root,'seed.json'),JSON.stringify({id:'lamp'}));
 await assertInstaller(root,'lamp');
 await writeFile(join(root,'SEED.json'),JSON.stringify({id:'orbit'}));
 await assert.rejects(assertInstaller(root,'lamp'),/product does not match/);
});
