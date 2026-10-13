import { queuedEntrypoint } from '../../onboarding/queued-entry.mjs';
const queuedExit=await queuedEntrypoint(import.meta.url,'verify:browser');
if(queuedExit!==null)process.exit(queuedExit);
// Exact committed product sources only. This proves acquisition/UI/resume, not app installation.
// node tests/release-acceptance.mjs manifest.json
// manifest: {evidence, playwrightModule, products:[{seed,repository,commit,draft}]}
import assert from 'node:assert/strict';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,readFile,writeFile,lstat,copyFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { launchDiagnostics, launchTimeoutMs } from './launch-diagnostics.mjs';
const run=promisify(execFile);
const manifest=JSON.parse(await readFile(process.argv[2],'utf8'));
const evidence=resolve(manifest.evidence);await mkdir(evidence,{recursive:true});
const work=await mkdtemp(join(evidence,'owner-checkouts-'));
const launcher=fileURLToPath(new URL('../',import.meta.url));
const children=new Set(),processes=[];let browser;
async function stop(child){
 if(child.exitCode!==null)return;
 await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Installer did not terminate')),15000);child.once('exit',()=>{clearTimeout(timer);done()});child.kill('SIGTERM')});children.delete(child);const record=processes.find(item=>item.pid===child.pid);if(record)record.stopped=true;
}
async function launch(seed,args){
 const started=performance.now();
 const child=spawn(process.execPath,[join(work,'package/bin/rer-setup.mjs'),seed,'--no-open','--port',String(manifest.port??0),...args],{cwd:work,stdio:['ignore','pipe','pipe']});children.add(child);
 let output='',sourceReadyMs;
 const collect=data=>{output+=data;if(sourceReadyMs===undefined&&output.includes(`Opening ${seed} setup;`))sourceReadyMs=Math.round(performance.now()-started)};
 child.stdout.on('data',collect);child.stderr.on('data',collect);
 const origin=await new Promise((done,fail)=>{
  let finished=false;
  const onExit=code=>finish(Error(`Setup exited ${code}: ${output}`));
  function finish(error,value){if(finished)return;finished=true;clearInterval(poll);clearTimeout(timer);child.off('exit',onExit);error?fail(error):done(value)}
  const timer=setTimeout(async()=>{
   clearInterval(poll);
   try{
    const diagnostics=await launchDiagnostics(child,started,output,args[args.indexOf('--directory')+1],{sourceReadyMs});
    await writeFile(join(evidence,`${seed}-launch-failure.json`),diagnostics);
    finish(Error(`Setup timed out: ${diagnostics}`));
   }catch(error){finish(Error(`Setup timed out; diagnostics failed (${error.message}): ${output}`))}
  },launchTimeoutMs);
  const poll=setInterval(()=>{const match=output.match(/installer: (http:\/\/127\.0\.0\.1:\d+)/);if(match)finish(null,match[1])},40);
  child.once('exit',onExit);
 });
 const elapsedMs=Math.round(performance.now()-started);
 console.log(JSON.stringify({launcherStartup:seed,elapsedMs,sourceReadyMs,installerReadyMs:elapsedMs-sourceReadyMs}));
 processes.push({pid:child.pid,seed,origin,stopped:false});return {child,origin};
}
async function session(origin){const page=await fetch(origin),html=await page.text();assert.equal(page.status,200);const headers={Origin:origin,Cookie:page.headers.get('set-cookie').split(';')[0],'X-Installer-Token':html.match(/name="installer-token" content="([a-f0-9]+)"/)[1],'Content-Type':'application/json'};return async(path,body)=>{const response=await fetch(origin+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});assert.equal(response.status,200);return response.json()};}
const results=[];
try{
 const packed=JSON.parse((await run('npm',['pack','--json','--pack-destination',work],{cwd:launcher})).stdout)[0];
 assert(packed.files.every(file=>/^(bin\/|lib\/|README.md$|LICENSE$|package.json$)/.test(file.path)));
 const tarball=join(work,packed.filename);await copyFile(tarball,join(evidence,packed.filename));
 const hash=createHash('sha256').update(await readFile(tarball)).digest('hex');
 await run('tar',['-xzf',tarball,'-C',work]);
 const pw=await import(pathToFileURL(resolve(manifest.playwrightModule)));browser=await pw.chromium.launch({headless:true});
 for(const product of manifest.products){
  assert.match(product.commit,/^[a-f0-9]{40}$/);
  const directory=join(work,product.seed);
  const active=await launch(product.seed,['--repository',product.repository,'--ref',product.commit,'--directory',directory,'--no-prefill']);
  const api=await session(active.origin);assert.deepEqual((await api('/api/state')).draft,{});
  assert.equal((await run('git',['rev-parse','HEAD'],{cwd:directory})).stdout.trim(),product.commit);
  const receipt=JSON.parse(await readFile(join(directory,'.git/rer-setup.json'),'utf8'));assert.equal(receipt.commit,product.commit);assert.equal(receipt.seed,product.seed);
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(active.origin);await page.locator('#loading').waitFor({state:'hidden'});assert.deepEqual(errors,[]);await page.screenshot({path:join(evidence,`${product.seed}.png`),fullPage:true});await page.close();
  assert.equal((await fetch(active.origin+'/api/state')).status,403);
  if(product.draft)await api('/api/draft',product.draft);
  for(const name of ['node_modules','dist','.output'])assert.equal(await lstat(join(directory,name)).catch(()=>null),null,`${name} must not exist before Start`);
  await stop(active.child);await writeFile(join(directory,'owner-custom.txt'),'Retained editable owner source\n');
  await run('git',['remote','set-url','origin',join(work,'unavailable-upstream')],{cwd:directory});
  const resumed=await launch(product.seed,['--directory',directory,'--resume']);const state=await (await session(resumed.origin))('/api/state');
  for(const [key,value] of Object.entries(product.draft||{}))assert.equal(state.draft[key],value);
  assert.equal(await readFile(join(directory,'owner-custom.txt'),'utf8'),'Retained editable owner source\n');
  assert.equal((await run('git',['rev-parse','HEAD'],{cwd:directory})).stdout.trim(),product.commit);
  await stop(resumed.child);await writeFile(join(evidence,`${product.seed}-receipt.json`),JSON.stringify(receipt,null,2));
  results.push({seed:product.seed,commit:product.commit,directory,result:'passed',checks:['exact source','real browser without dependencies','unauthenticated denial','draft persistence','offline resume preserves edits']});
 }
 await writeFile(join(evidence,'acceptance.json'),JSON.stringify({work,tarballSha256:hash,processes,results},null,2));console.log(JSON.stringify({work,tarballSha256:hash,processes,results},null,2));
}finally{await browser?.close();for(const child of children)await stop(child);}
