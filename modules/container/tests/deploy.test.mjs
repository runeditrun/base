import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {deployInputs} from '../deploy-input.mjs';
test('container deploy refuses development secrets and unsafe private input before any image or host operation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rer-deploy-input-')),root=join(import.meta.dirname,'../../../default-seed');
 const path=join(directory,'settings.env'),secret='private-value-'+crypto.randomUUID();
 try{
  for (const key of ['RER_DEV_KEY','RER_MODELS_KEY','RER_MODELS_SERVICE']) {
   await writeFile(path,'AUTH_ORIGIN=https://app.example.test\n'+key+'='+secret+'\n',{mode:0o600});
   await assert.rejects(deployInputs({root,envFile:path}),/Local-only/);
  }
  const child=spawnSync(process.execPath,[join(root,'scripts/rer.mjs'),'deploy','--platform','container','--host','ssh://owner@host.invalid','--env-file',path,'--no-queue','--non-interactive','--json'],{cwd:root,env:{...process.env,CI:'true'},encoding:'utf8',timeout:60000});
  assert.notEqual(child.status,0);assert.ok(!((child.stdout??'')+(child.stderr??'')).includes(secret));
  await writeFile(path,'AUTH_ORIGIN=https://app.example.test\nSESSION_SECRET='+secret+'\n');await chmod(path,0o644);await assert.rejects(deployInputs({root,envFile:path}),/owned private/);
  await chmod(path,0o600);await symlink(path,join(directory,'linked.env'));await assert.rejects(deployInputs({root,envFile:join(directory,'linked.env')}));
  assert.equal((await deployInputs({root,envFile:path})).settings.SESSION_SECRET,secret);
 }finally{await rm(directory,{recursive:true,force:true});}
});
