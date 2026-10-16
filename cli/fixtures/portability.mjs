import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { exportReference } from '../../scripts/export-reference.mjs';
import { isolatedQueue } from './queue.mjs';
import { useWorkspaceDependencies } from './workspace-dependencies.mjs';

const base=resolve(import.meta.dirname,'../..');
export const generatedSQL=`CREATE TABLE computed_entries (
  id TEXT PRIMARY KEY,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  label TEXT,
  total INTEGER GENERATED ALWAYS AS (quantity * unit_price) STORED,
  description TEXT AS (coalesce(label, 'unlabelled') || ': ' || total) VIRTUAL
);
CREATE INDEX computed_entries_total ON computed_entries(total);`;

// A runnable exported reference, using the checkout's installed dependencies.
// Migrations and transfer use the public runner without building the application.
export async function portabilityFixture(t,{generated=true}={}) {
 const directory=await mkdtemp(join(tmpdir(),'rer-data-journey-')),root=join(directory,'installation');
 const children=new Set();
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await child.done;}await rm(directory,{recursive:true,force:true});});
 await exportReference(base,root);
 await mkdir(join(root,'exports'));
 await useWorkspaceDependencies(root);
 if(generated)await writeFile(join(root,'migrations/core/0999_computed_entries.sql'),generatedSQL);
 const env=await isolatedQueue(t,{PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',WRANGLER_SEND_METRICS:'false',RER_NODE_AUTO:'0'});
 async function command(args,expected=0) {
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.add(child);
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const code=await child.done;
  assert.equal(code,expected,`Fixture command ${args[0]} exited ${code}: ${stdout}\n${stderr}`);
  return {stdout,stderr};
 }
 const run=async(args,expected=0,{slow=false}={})=>(await command([...(slow?['--import',join(base,'cli/fixtures/slow-state-inspection.mjs')]:[]),'scripts/rer.mjs',...args,'--json'],expected)).stdout.trim().split('\n').map(JSON.parse);
 // A command as a person runs it, without --json: its terminal output.
 const text=(args,expected=0)=>command(['scripts/rer.mjs',...args],expected);
 const data=async sql=>JSON.parse((await command(['node_modules/wrangler/bin/wrangler.js','d1','execute','default-seed-reference','--local','--persist-to','.wrangler/state','--config','wrangler.jsonc','--command',sql,'--json'])).stdout);
 return {root,run,text,data};
}
