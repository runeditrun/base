import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
/** Native default-seed consumer: real local workerd/D1/session, fixture frame only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixtureProvider } from './provider.mjs';
const { chromium }=await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');
const root=resolve(process.argv[2]);const evidence=resolve(process.env.RER_EDITOR_EVIDENCE);
import { startNativeConsumer } from './native-consumer-runtime.mjs';
let runtime,browser;
try {
  runtime=await startNativeConsumer(root,evidence,'consumer_fixture');
  const {origin,provider}=runtime;
  const denied=await fetch(origin+'/api/editor/config');assert.equal(denied.status,403);assert.equal(denied.headers.get('x-reference-dispatch'),'hono');assert.match(denied.headers.get('cache-control'),/no-store/);
  browser=await chromium.launch({headless:true,...(process.env.RER_BROWSER_CHANNEL?{channel:process.env.RER_BROWSER_CHANNEL}:{})});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/app');await page.waitForURL(url => url.pathname === '/signin');assert.equal(await page.locator('[data-rer-editor]').count(),0);assert.equal(provider.state.requests,0);
  await runtime.login(page);
  const configured=await page.request.get(origin+'/api/editor/config');assert.equal(configured.status(),200);assert.match(configured.headers()['cache-control'],/no-store/);const grant=await configured.json();assert.equal(grant.config.installationId,'consumer_fixture');assert.deepEqual(Object.keys(grant).sort(),['config','expiresAt']);
  await page.goto(origin+'/app');await page.getByRole('button',{name:'Open Run Edit Run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-rer-editor]')?.dataset.connection==='connected');
  const captures=[];for(const width of [1440,390]) {await page.setViewportSize({width,height:900});await page.frameLocator('iframe').getByText('Labeled local management fixture').waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const path=join(evidence,`consumer-${width}.jpg`);await page.screenshot({path,type:'jpeg',quality:88});captures.push({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}
  await page.getByRole('button',{name:'Close Run Edit Run',exact:true}).click();
  await page.getByRole('link',{name:'Public record',exact:true}).click();await page.waitForURL(origin+'/records');await page.locator('[data-rer-editor]').waitFor({state:'detached'});assert.equal(await page.locator('[data-rer-editor]').count(),0);
  await page.getByRole('link',{name:'Operator app',exact:true}).click();await page.waitForURL('**/app');await page.getByRole('button',{name:'Open Run Edit Run',exact:true}).waitFor();
  // Revocation at the native server: the lease expires without any fake client grant.
  const logout=await page.request.post(origin+'/auth/signout',{headers:{origin},data:{}});assert.equal(logout.status(),204);
  assert.equal((await page.request.get(origin+'/api/editor/config')).status(),403);
  await page.locator('[data-rer-editor]').waitFor({state:'detached',timeout:35_000});assert.deepEqual(errors,[]);
  const consumerRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();const dirty=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();
  const result={status:'passed',checks:['native no-session denial','Hono dispatcher','no-store config','no public frame','native session mount','actual negotiated widget','route cleanup and remount','server revocation and bounded lease expiry'],consumerRevision,dirty,captures,provider:'labeled local fixture; no real management/stage claim'};
  await writeFile(join(evidence,'consumer-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {
  await browser?.close();await runtime?.close();
}
