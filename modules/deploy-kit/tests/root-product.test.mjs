import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageBuild } from '../prepare.mjs';
import { hash } from '../validation.mjs';

test('root-product adopter packages real ordered migration bytes and lazy modules through shared packer', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'kit-root-product-')));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ['dist/server','dist/client','migrations/core']) await mkdir(join(root,dir),{recursive:true});
  await writeFile(join(root,'dist/server/wrangler.json'),JSON.stringify({main:'index.js',no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}]}));
  await writeFile(join(root,'dist/server/index.js'),'export default {};');
  await writeFile(join(root,'dist/server/lazy.mjs'),'export const value=1;');
  await writeFile(join(root,'dist/client/style.css'),'body{}');
  const sql='CREATE TABLE owner(id TEXT PRIMARY KEY);';
  await writeFile(join(root,'migrations/core/0001_owner.sql'),sql);
  const artifact=await packageBuild({root,productDirectory:'',source:{sha:'a'.repeat(40),tree:'b'.repeat(40)},runIdentity:{id:'1',attempt:'1'}});
  assert.deepEqual(artifact.modules.map(x=>x.path),['index.js','lazy.mjs']);
  assert.deepEqual(artifact.migrations,[{binding:'DB',name:'0001_owner.sql',sql,sha256:hash(sql)}]);
  assert.equal(Buffer.from(artifact.assets[0].base64,'base64').toString(),'body{}');
  const args={root,productDirectory:'',source:artifact.source,runIdentity:artifact.run};
  const bytes=JSON.stringify(artifact);
  await writeFile(join(root,'wrangler.jsonc'),'{"d1_databases":[{"binding":"DB"}]}');
  assert.equal(JSON.stringify(await packageBuild(args)),bytes);
  // An explicit legacy path and a flat native declaration package identical SQL
  // without requiring a second, staged migration tree.
  await writeFile(join(root,'wrangler.jsonc'),'{"d1_databases":[{"binding":"DB","migrations_dir":"migrations/core"}]}');
  assert.equal(JSON.stringify(await packageBuild(args)),bytes);
  await rename(join(root,'migrations/core/0001_owner.sql'),join(root,'migrations/0001_owner.sql'));
  await rm(join(root,'migrations/core'),{recursive:true});
  await writeFile(join(root,'wrangler.jsonc'),'{\n// Native flat migrations\n"d1_databases":[{"binding":"DB","migrations_dir":"migrations",}],\n}');
  assert.equal(JSON.stringify(await packageBuild(args)),bytes);
  await writeFile(join(root,'wrangler.jsonc'),'{"d1_databases":[{"binding":"DB","migrations_dir":"../outside"}]}');
  await assert.rejects(packageBuild(args),/invalid-local-path/);
  await assert.rejects(packageBuild({root,productDirectory:'../escape'}),/invalid-local-path/);
});
