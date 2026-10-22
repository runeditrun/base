// Run outside push Verify, under the fleet heavy slot, in an owned process
// group. RER_PROXY_BASELINE names an unmodified server-proxy.mjs from main.
import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture,pause,chromium } from '../../fixtures/reference.mjs';
import { useWorkspaceDependencies } from '../../fixtures/workspace-dependencies.mjs';

const cleanups=[],context={after:fn=>cleanups.push(fn),diagnostic:message=>console.error(message)};
const evidence=process.env.RER_TEST_EVIDENCE_DIRECTORY;
assert.ok(evidence,'Set RER_TEST_EVIDENCE_DIRECTORY outside the checkout');
await mkdir(evidence,{recursive:true});
const baseline=process.env.RER_PROXY_BASELINE;
assert.ok(baseline,'Set RER_PROXY_BASELINE to the original proxy source');
const candidate=await readFile(new URL('../../server-proxy.mjs',import.meta.url));
const results=[];
try {
 const f=await fixture('default-seed',context);
 await useWorkspaceDependencies(f.root);
 await f.run(['setup','--owner-email','synthetic-proxy-owner@example.test','--non-interactive','--json']);
 const config=join(f.root,'vite.config.ts'),source=await readFile(config,'utf8');
 const accepts=join(f.root,'proxy-accepts.jsonl');
 // Observe actual Vite accepts, not requests or the proxy's public sockets.
 await writeFile(config,"import {appendFileSync} from 'node:fs';\n"+source.replace('plugins: [seedIcons(),',`plugins: [{name:'proxy-connection-observer',configureServer(server){server.httpServer.on('connection',()=>appendFileSync(${JSON.stringify(accepts)},JSON.stringify({port:server.httpServer.address().port,keepAliveTimeout:server.httpServer.keepAliveTimeout})+'\\n'));}},seedIcons(),`));
 const folder=join(f.root,'public/proxy-load');await mkdir(folder,{recursive:true});
 const imports=[],values=[];
 for(let i=0;i<300;i++){
  await writeFile(join(folder,`module-${i}.js`),`export default ${i+1};\n`);
  imports.push(`import amount${i} from './module-${i}.js';`);values.push(`amount${i}`);
 }
 await writeFile(join(folder,'page.js'),imports.join('\n')+`\ndocument.querySelector('#total').textContent=String(${values.join('+')});document.querySelector('#state').textContent='300 invoices loaded';\n`);
 await writeFile(join(folder,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice module load</title><style>body{font:18px system-ui;margin:24px;color:#162122;max-width:70ch}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}</style><h1>October invoices</h1><p id="state">Loading invoices</p><table><tr><th>Account</th><th>Amount</th></tr><tr><td>Terrace studio</td><td>$15,050</td></tr><tr><td>Northside workshop</td><td>$15,050</td></tr><tr><td>River co-op</td><td>$15,050</td></tr></table><p>Total: $<strong id="total">0</strong></p><script type="module" src="./page.js"></script>');
 const rows=async()=> (await readFile(accepts,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
 async function timeWait(port){
  const {stdout}=await promisify(execFile)('/usr/sbin/netstat',['-an','-p','tcp'],{maxBuffer:16*1024*1024});
  return stdout.split('\n').filter(line=>line.includes('TIME_WAIT')&&line.trim().split(/\s+/).slice(3,5).some(address=>address===`127.0.0.1.${port}`)).length;
 }
 for(const mode of ['before','after']){
  const proxy=join(f.root,'scripts/base-cli/cli/server-proxy.mjs');
  if(mode==='before')await copyFile(baseline,proxy);else await writeFile(proxy,candidate);
  const child=f.start(['dev','--foreground','--json']);let browser;
  try {
   const deadline=Date.now()+180000;let ready;
   while(!ready&&child.exitCode===null&&Date.now()<deadline){
    ready=child.stdoutText.split('\n').filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(row=>row.event==='ready');
    if(!ready)await pause(100);
   }
   assert.ok(ready,'rer dev must reach its public ready event');
   const startup=await rows(),port=startup.at(-1).port,twBefore=await timeWait(port),count=startup.length;
   browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
   for(const width of [1440,390]){
    const browserContext=await browser.newContext({viewport:{width,height:900}});
    try {
     const page=await browserContext.newPage();
     await page.goto(ready.url+'/proxy-load/index.html');
     await page.waitForFunction(()=>document.querySelector('#total')?.textContent==='45150');
     assert.equal(await page.locator('#state').textContent(),'300 invoices loaded');
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
     await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});
    }finally{await browserContext.close();}
   }
   const loaded=await rows();
   const result={mode,newUpstreamConnections:loaded.length-count,timeWaitBefore:twBefore,timeWaitAfter:await timeWait(port),vitePort:port,keepAliveTimeout:loaded.at(-1).keepAliveTimeout};
   results.push(result);console.log(JSON.stringify(result));
   if(mode==='after')assert.ok(result.newUpstreamConnections<20,'the two 300-module page loads must reuse a bounded upstream pool');
  }finally{await browser?.close();await f.stop(child);}
 }
 await writeFile(join(evidence,'socket-counts.json'),JSON.stringify(results,null,2)+'\n');
}finally{for(const cleanup of cleanups.reverse())await cleanup();}
