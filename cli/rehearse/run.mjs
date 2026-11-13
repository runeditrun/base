import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {join, relative, isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {shared} from '../shared.mjs';
import {projectInstallation, restoreArchive} from './snapshot.mjs';
import {rehearsalEnvironment} from './environment.mjs';

const execute=promisify(execFile), order=['setup','build','verify','artifact'];
const firstLine=value=>String(value).split(/\r?\n/).map(line=>line.trim()).find(Boolean);
const missingInput=/(?:ENOENT|Cannot find (?:module|package)|command not found|No such file or directory|cannot (?:open|access)|missing (?:build|artifact|output))/i;
const causeLine=text=>text.split(/\r?\n/).map(line=>line.trim()).find(line=>/error|failed|missing|cannot|not found|ERR_|contract_anchor/i.test(line)) ?? firstLine(text);

export async function rehearse(options, progress) {
 const started=performance.now(), controller=new AbortController();
 const timer=setTimeout(()=>controller.abort('Overall rehearsal deadline reached.'),options.timeoutSeconds*1000);
 const handlers=new Map(['SIGINT','SIGTERM'].map(signal=>[signal,()=>controller.abort(signal)]));
 for (const [signal,handler] of handlers) process.on(signal,handler);
 let scratch,store,captureDirectory,currentOutput='',phase='Preparing managed copy';
 const operations=[], result={sourceRef:options.ref, runtime:{node:process.version,platform:process.platform,arch:process.arch}, operations};
 const elapsed=()=>Number(((performance.now()-started)/1000).toFixed(3));
 try {
  scratch=await mkdtemp(join(tmpdir(),'rer-rehearse-'));
  // Logs live separately so cleanup does not discard the reason a signer needs.
  captureDirectory=await mkdtemp(join(tmpdir(),'rer-rehearse-log-'));
  const home=join(scratch,'home'), root=join(scratch,'repository');await mkdir(home);await mkdir(root);
  const env=rehearsalEnvironment(home,'rer-worker-artifact.json');
  const {createCommands}=await shared('commands.mjs');
  store=await createCommands(captureDirectory,{logs:[]},{terminal:text=>{currentOutput=(currentOutput+text).slice(-65536);}});
  result.captureLog=store.logPath;
  const git=async (cwd,...args)=>(await execute('git',['-C',cwd,...args],{env,signal:controller.signal,maxBuffer:64*1024*1024})).stdout;
  const sourceRoot=(await git(options.cwd,'rev-parse','--show-toplevel')).trim();
  const inside=relative(sourceRoot,scratch);
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) throw Error('The temporary directory must be outside the source checkout. Set TMPDIR to an external directory.');
  result.sourceCommit=(await git(sourceRoot,'rev-parse','--verify',`${options.ref}^{commit}`)).trim();
  const sourceCommit=result.sourceCommit;
  const entries=(await git(sourceRoot,'ls-tree','-rz','--full-tree',sourceCommit)).split('\0').filter(Boolean).map(row=>{
   const tab=row.indexOf('\t'), [mode,type,id]=row.slice(0,tab).split(' ');if(type!=='blob')throw Error('Unsupported external Git objects in source tree.');
   return {mode,id,path:row.slice(tab+1)};
  });
  const run=(name,command,args,cwd=root,signal=controller.signal)=>store.run(name,command,args,{cwd,env,signal,display:[command,...args].join(' ')});
  await run(phase,'git',['-C',sourceRoot,'archive','--format=tar',`--output=${join(scratch,'source.tar')}`,sourceCommit]);
  await run(phase,'tar',['-xf',join(scratch,'source.tar'),'-C',root]);
  await restoreArchive(root,entries,async id=>(await execute('git',['-C',sourceRoot,'cat-file','blob',id],{env,signal:controller.signal,encoding:'buffer',maxBuffer:64*1024*1024})).stdout);
  const descriptor=JSON.parse(await readFile(join(root,'rer-project.json'),'utf8'));
  if (descriptor.schema!==1 || descriptor.deployment?.target!=='cloudflare-workers' || !descriptor.operations ||
      !['build','verify'].every(name=>typeof descriptor.operations[name]==='string' && descriptor.operations[name].trim())) throw Error('rer-project.json must declare schema 1, cloudflare-workers, build and verify operations.');
  for (const name of order) if (descriptor.operations[name]!==undefined && (typeof descriptor.operations[name]!=='string' || !descriptor.operations[name].trim())) throw Error(`rer-project.json operations.${name} must be a nonempty shell command.`);
  const artifactFile=descriptor.deployment.artifactFile??'rer-worker-artifact.json';
  if (!/^[\w.-]+\.json$/.test(artifactFile)) throw Error('Invalid deployment artifact filename.');
  env.ARTIFACT_FILE=artifactFile;
  const repository=(options.repository??descriptor.sourceRepository??'').replace(/^https:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/\/$/,'');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository)) throw Error('Provide --repository OWNER/REPO or declare sourceRepository in rer-project.json.');
  result.repository=repository;
  await run(phase,'git',['init','-q','--initial-branch=main']);
  await run(phase,'git',['-c','core.hooksPath=/dev/null','commit','-q','--allow-empty','-m','Initial commit']);
  await projectInstallation(root,entries,{repository,ref:options.ref,sourceCommit,workflowRef:options.workflowRef,artifactFile});
  await run(phase,'git',['add','--all','--force']);
  await run(phase,'git',['-c','core.hooksPath=/dev/null','commit','-q','-m',`Install ${descriptor.projectId??repository} from ${repository}@${sourceCommit}\n\n[skip ci]\n`]);
  result.installCommit=(await git(root,'rev-parse','HEAD')).trim();
  result.installTree=(await git(root,'rev-parse','HEAD^{tree}')).trim();
  if (options.keep) result.scratch=root;
  for (const name of order.filter(name=>descriptor.operations[name]!==undefined)) {
   const command=descriptor.operations[name], operationStarted=performance.now();
   if (controller.signal.aborted) {operations.push({name,command,status:'NOT REACHED',cause:String(controller.signal.reason),seconds:0});continue;}
   progress?.(`Rehearsing ${name}…`); phase=name;currentOutput='';
   const deadline=AbortSignal.timeout(options.operationTimeoutSeconds*1000), signal=AbortSignal.any([controller.signal,deadline]);
   try {
    await run(name,'/bin/bash',['-e','-o','pipefail','-c',command],root,signal);
    operations.push({name,command,status:'PASS',exitCode:0,seconds:Number(((performance.now()-operationStarted)/1000).toFixed(3))});
   } catch (error) {
    const output=store.redact(currentOutput), earlier=operations.filter(row=>row.status!=='PASS').map(row=>row.name);
    const unavailable=earlier.length>0 && missingInput.test(output);
    const cause=controller.signal.aborted?String(controller.signal.reason):deadline.aborted?`Operation exceeded ${options.operationTimeoutSeconds} seconds.`:causeLine(output.replace(new RegExp(`^${name}\\s*\\n`),''))??firstLine(error.message);
    operations.push({name,command,status:unavailable?'NOT REACHED':'FAIL',cause:unavailable?`Missing prerequisite after ${earlier.join(', ')} failed: ${cause}`:cause,exitCode:error.childExitCode??null,signal:error.signal??null,seconds:Number(((performance.now()-operationStarted)/1000).toFixed(3))});
   }
  }
  result.exitCode=operations.every(row=>row.status==='PASS')?0:1;
 } catch (error) {
  result.exitCode=3;
  const cause=error.step ? causeLine(error.step.output.join('\n'))??firstLine(error.message) : firstLine(error.message);
  result.cause=store?.redact(cause)??cause;
  store?.report(`${phase}: ${error.message}`,{logOnly:true});
 } finally {
  clearTimeout(timer);
  for (const [signal,handler] of handlers) process.off(signal,handler);
  try {await store?.closeCommands();} catch(error) {result.exitCode=3;result.cause=store?.redact(firstLine(error.message));}
  if (controller.signal.aborted) result.exitCode=controller.signal.reason==='SIGINT'?130:controller.signal.reason==='SIGTERM'?143:124;
  if (scratch && !options.keep) await rm(scratch,{recursive:true,force:true});
  result.seconds=elapsed();result.ok=result.exitCode===0;
 }
 return result;
}
