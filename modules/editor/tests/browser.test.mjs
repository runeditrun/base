import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureProvider } from './provider.mjs';
const { build }=await import(process.env.RER_ESBUILD_MODULE || 'esbuild');
const { chromium }=await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');
const root=fileURLToPath(new URL('..',import.meta.url));
test('real widget authority, negotiation, overlays, lifecycle races and CSP in Chrome', async()=>{
  const provider=await fixtureProvider();let browser,server;
  try {
    const bundle=await build({stdin:{contents:`import {createOwnerEditor,installCompiledLiveEdits,setLiveEditsReady} from './src/index.ts';
window.editor=createOwnerEditor();window.setReady=setLiveEditsReady;window.install=installCompiledLiveEdits;
window.grant=()=>({config:{enabled:true,managementOrigin:${JSON.stringify(provider.origin)},installationId:'fixture_install'},expiresAt:Date.now()+30000});
window.mount=()=>{editor.setOwner(true);return editor.refresh(async()=>grant());};`,resolveDir:root},bundle:true,format:'esm',write:false});
    server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','application/javascript');res.end(bundle.outputFiles[0].text);return;}res.setHeader('content-type','text/html');res.setHeader('content-security-policy',`default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src ${provider.origin}`);res.end('<!doctype html><html><head><title>Editor module browser fixture</title></head><body><main><h1>Original heading</h1><p>Explicit test fixture for the copied editor module.</p></main><script type="module" src="/app.js"></script></body></html>');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;provider.state.allowed=origin;
    browser=await chromium.launch({headless:true,...(process.env.RER_BROWSER_CHANNEL?{channel:process.env.RER_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage();const security=[];page.on('console',message=>{if(message.text().includes('frame-ancestors'))security.push(message.text());});await page.goto(origin);await page.waitForFunction(()=>window.editor);
    assert.equal(await page.evaluate(()=>editor.refresh(async()=>grant())),'unauthorized');assert.equal(provider.state.requests,0);
    await page.evaluate(async()=>{editor.setOwner(true);try{await editor.refresh(async()=>({...grant(),config:{...grant().config,installationId:42}}));}catch{}});assert.equal(provider.state.requests,0);
    const edit={id:'published',revision:1,path:'/',target:{selector:'main:nth-child(1) > h1:nth-child(1)',tag:'h1',role:'',beforeText:'Original heading'},change:{text:'Published heading'}};
    await page.evaluate(e=>{setReady(false);install({revision:1,edits:[e]});},edit);assert.equal(await page.locator('h1').textContent(),'Original heading');
    await page.evaluate(()=>setReady(true));await page.getByRole('heading',{name:'Published heading'}).waitFor();
    await page.evaluate(()=>mount());await page.getByRole('button',{name:'Open Run Edit Run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-rer-editor]')?.dataset.connection==='connected');
    const frame=page.frames().find(f=>f.url().startsWith(provider.origin));assert.ok(frame);
    const pending={revision:2,edits:[{...edit,revision:2,parentOrigin:origin,change:{text:'Private pending heading'}}]};
    await frame.evaluate(snapshot=>parent.postMessage({protocol:'rer-editor',version:1,installationId:new URL(location.href).searchParams.get('installation'),sessionId:'expired_session_012345',type:'live-edits',snapshot},new URL(location.href).searchParams.get('parentOrigin')),pending);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.locator('h1').textContent(),'Published heading');
    await page.evaluate(snapshot=>window.postMessage({protocol:'rer-editor',version:1,installationId:'fixture_install',sessionId:'spoofed_session_012345',type:'live-edits',snapshot},location.origin),pending);
    assert.equal(await page.locator('h1').textContent(),'Published heading');
    await frame.evaluate(snapshot=>send('live-edits',{snapshot}),pending);await page.getByRole('heading',{name:'Private pending heading'}).waitFor();
    await page.evaluate(()=>editor.setOwner(false));assert.equal(await page.locator('[data-rer-editor]').count(),0);await page.getByRole('heading',{name:'Published heading'}).waitFor();
    await page.evaluate(async()=>{editor.setOwner(true);let resolve;const result=editor.refresh(()=>new Promise(r=>resolve=r));editor.setOwner(false);resolve(grant());await result;});assert.equal(await page.locator('[data-rer-editor]').count(),0);
    for(const mode of ['incompatible','denied','valid']) {
      provider.state.mode=mode;
      await page.evaluate(()=>mount());await page.getByRole('button',{name:'Open Run Edit Run',exact:true}).click();
      await page.waitForFunction(expected=>document.querySelector('[data-rer-editor]')?.dataset.connection===expected,mode==='valid'?'connected':mode==='denied'?'timeout':'incompatible');
      if(mode==='denied')assert.ok(security.some(message=>message.includes("frame-ancestors 'none'")),'browser must report the frame-ancestors denial');
      if(mode!=='valid') {await page.getByRole('status').filter({hasText:'could not connect'}).waitFor();await page.evaluate(()=>editor.revoke());}
    }
    if(process.env.RER_EDITOR_EVIDENCE){const dir=process.env.RER_EDITOR_EVIDENCE;await mkdir(dir,{recursive:true});const captures=[];for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.frameLocator('iframe').getByText('Labeled local management fixture').waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const path=`${dir}/module-${width}.jpg`;await page.screenshot({path,type:'jpeg',quality:88});captures.push({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();const dirty=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();await writeFile(`${dir}/captures.json`,JSON.stringify({commit,dirty,captures,security,provider:'labeled fixture; not service gate'},null,2));}
    await page.evaluate(()=>{editor.dispose();editor.dispose();});assert.equal(await page.locator('[data-rer-editor]').count(),0);await page.getByRole('heading',{name:'Published heading'}).waitFor();
  } finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await provider.close();}
});
