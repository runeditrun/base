import { productionSender } from './production-sender.mjs';
import { retainStartupFailure } from './command-diagnostic.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { exportReference } from '../../scripts/export-reference.mjs';
import { isolatedQueue } from './queue.mjs';
import { useWorkspaceDependencies } from './workspace-dependencies.mjs';
import { commandCustody } from '../../onboarding/command-custody.mjs';
import { createProcessBaseline, createProcessScope } from '../../onboarding/process-scope.mjs';

const base=resolve(import.meta.dirname,'../..');
export const generatedSQL=`CREATE TABLE computed_entries (
  id TEXT PRIMARY KEY,
  -- Quantity and unit price are the stored invoice inputs.
  quantity INTEGER NOT NULL,
  /* SQLite computes both totals from these base cells. */
  unit_price INTEGER NOT NULL,
  label TEXT,
  total INTEGER GENERATED ALWAYS AS (quantity * unit_price) STORED,
  description TEXT AS (coalesce(label, 'unlabelled') || ': ' || total) VIRTUAL
);
CREATE INDEX computed_entries_total ON computed_entries(total);`;

// A runnable exported reference, using the checkout's installed dependencies.
// Migrations and transfer use the public runner without building the application.
export async function portabilityFixture(t,{generated=true,receiptWorker=false}={}) {
 const directory=await mkdtemp(join(tmpdir(),'rer-data-journey-')),root=join(directory,'installation');
 const children=new Set();
 let closing;
 const stop=()=>closing??=Promise.allSettled([...children].map(child=>child.custody?.stop())).then(results=>{
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'Fixture process cleanup failed');
 });
 const cancelled=()=>{void stop().catch(()=>{});};
 t.signal.addEventListener('abort',cancelled,{once:true});
 t.after(async()=>{
  try {
   await stop();
  } finally {
   t.signal.removeEventListener('abort',cancelled);
   await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
 });
 await exportReference(base,root);
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 declaration.vars.MAIL_FROM = productionSender;
 await writeFile(join(root, 'deploy.json'), JSON.stringify(declaration));
 if(receiptWorker) {
  // A seed-owned worker, like Spool's adapter, reports its real export receipt
  // on stdout while the command store captures both child streams.
  const adapter=join(root,'scripts/installer/local.mjs');
  await writeFile(adapter,await readFile(adapter,'utf8')+`
const nativeExport=commandAdapter.portability.export;
commandAdapter.portability.export=async context=>{
 const receipt=await nativeExport(context);
 await context.store.run('Reporting archive receipt',process.execPath,['-e',
  "console.error('Archive integrity checked'); console.log(process.argv[1]);",JSON.stringify({ok:true,...receipt})],{cwd:context.root,signal:context.signal});
 return receipt;
};
`);
 }
 await mkdir(join(root,'exports'));
 await useWorkspaceDependencies(root);
 if(generated)await writeFile(join(root,'migrations/core/0999_computed_entries.sql'),generatedSQL);
 const env=await isolatedQueue(t,{PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',WRANGLER_SEND_METRICS:'false',RER_NODE_AUTO:'0'});
 const baseline=await createProcessBaseline();
 async function command(args,expected=0,extraEnv={}) {
  t.signal.throwIfAborted();
  assert.ok(!closing,'Fixture is shutting down');
  const scope=createProcessScope(baseline);
  const environment={...env,...extraEnv,RER_TEST_COMMAND_SCOPE:scope.token};
  environment.NODE_OPTIONS=[environment.NODE_OPTIONS,`--import=${pathToFileURL(join(base,'cli/fixtures/command-scope.mjs')).href}`].filter(Boolean).join(' ');
  const child=spawn(process.execPath,args,{cwd:root,env:environment,stdio:['ignore','pipe','pipe']});children.add(child);
  child.custody=commandCustody(child,scope);
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  child.done=new Promise(resolve=>child.once('close',resolve));
  // Exit can precede close indefinitely when a descendant inherited a pipe.
  // Retain custody after parent exit and stop only this launch's recorded
  // process identities, including detached helpers, before awaiting its pipes.
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  try { await exited; }
  finally { await child.custody?.stop(); }
  const code=await child.done;
  t.signal.throwIfAborted();
  if(code!==expected)await retainStartupFailure(root,{stdoutText:stdout,exitCode:child.exitCode,signalCode:child.signalCode});
  assert.equal(code,expected,`Fixture command ${args[0]} exited ${code}: ${stdout}\n${stderr}`);
  return {stdout,stderr};
 }
 const run=async(args,expected=0,{slow=false}={})=>(await command([...(slow?['--import',join(base,'cli/fixtures/slow-state-inspection.mjs')]:[]),'scripts/rer.mjs',...args,'--json'],expected)).stdout.trim().split('\n').map(JSON.parse);
 // A command as a person runs it, without --json: its terminal output.
 // `fault` names a transfer-fault.mjs failure for the transfer worker.
 const text=(args,expected=0,{fault}={})=>command(['scripts/rer.mjs',...args],expected,fault?{NODE_OPTIONS:`--import=${join(base,'cli/fixtures/transfer-fault.mjs')}`,RER_TEST_TRANSFER_FAULT:fault}:{});
 const data=async sql=>JSON.parse((await command(['node_modules/wrangler/bin/wrangler.js','d1','execute','default-seed-reference','--local','--persist-to','.wrangler/state','--config','wrangler.jsonc','--command',sql,'--json'])).stdout);
 return {root,run,text,data};
}
