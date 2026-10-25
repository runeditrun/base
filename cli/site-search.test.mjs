import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { exportReference } from '../scripts/export-reference.mjs';
import { siteProvider } from '../modules/deploy-kit/tests/site-provider.mjs';
import { searchRuntime } from './fixtures/docs-search/runtime.mjs';
import { buildPackage } from '../scripts/rer-package.mjs';
import { integrity } from '../scripts/rer-package/registry.mjs';
import { readPackage } from '../global/update/archive.mjs';
import { buildSearchIndex } from '../modules/site/docs-search/index-build.mjs';
import { createSearcher } from '../modules/site/docs-search/retrieve.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');
const { default: AxeBuilder } = createRequire(join(base, 'default-seed/package.json'))('@axe-core/playwright');
const { chromium } = createRequire(join(base, 'default-seed/package.json'))('@playwright/test');

test('static docs search builds without network, reindexes changed headings, navigates locally and refuses stale assets', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-site-search-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(join(directory, 'home'));
 await exportReference(base, root);
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 const adapter = join(root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('site: {', `site: { runtime: { type:'docs-search', module:'docs-search', bindings:['ASSETS'], endpoint:'/docs-search-index.json', corpus:'.rer/docs-search/corpus.json' }, clients: { docsSearch:'scripts/base-cli/modules/site/docs-search/client.ts' },`).replace("entry: 'src/site/pages.ts'", "entry: 'src/site/pages.tsx'"));
 const pages = join(root, 'src/site/pages.tsx');
 const source = `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
 import {SearchField} from '../../scripts/base-cli/modules/site/docs-search/SearchField';
 export function sitePages({styles,clients}) {
  const text='Restore a backup by choosing the archive and reviewing its contents.';
  const html='<!doctype html><html lang="en"><head><title>Backup documentation</title><meta name="viewport" content="width=device-width, initial-scale=1">'+styles.map(href=>'<link rel="stylesheet" href="'+href+'">').join('')+'<style>:root{--paper:#fff;--ink:#162122;--ink-soft:#586366;--rule:#ddd}body{font:18px system-ui;margin:24px;max-width:900px}.docs-search{max-width:320px}</style></head><body><nav aria-label="Docs">'+renderToStaticMarkup(createElement(SearchField,{id:'search'}))+'</nav><main><h1 id="backups">Backups</h1><p>Keep and retrieve your saved archives.</p><h2 id="restore">Restore a backup</h2><p>'+text+'</p><h2 id="storage">Storage locations</h2><p>Choose the directory where archives are kept.</p><a href="/run">Run</a></main><script type="module" src="'+clients.docsSearch+'"></script></body></html>';
  return {pages:[{path:'/',html:'<a href="/run">Run</a><a href="/docs/backups">Backups</a>'},{path:'/run',html:'<h1>Run</h1>'},{path:'/docs/backups',html}],assets:[], searchPages:[{href:'/docs/backups',searchSections:[{anchor:'backups',titlePath:['Backups'],text:'Keep and retrieve your saved archives.'},{anchor:'restore',titlePath:['Backups','Restore a backup'],text},{anchor:'storage',titlePath:['Backups','Storage locations'],text:'Choose the directory where archives are kept.'}]}]};
 }`;
 await writeFile(pages, source);
 const provider = siteProvider({ domain:'run-search.example.test' });
 t.after(() => provider.close());
 await writeFile(join(root, 'deploy-site.json'), JSON.stringify({version:1,domain:'run-search.example.test'}));
 let requests = 0;
 const edge = createServer(async (req, res) => {
  try {
   requests++;
   const destination = req.headers['x-test-destination'];
   const chunks=[]; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
   const headers = new Headers(req.headers); headers.delete('host'); headers.delete('x-test-destination');
   const request = new Request(destination, {method:req.method,headers,...(req.method !== 'GET' ? {body} : {})});
   const init = {method:req.method,headers:Object.fromEntries(headers)};
   if (req.method !== 'GET') init.body = headers.get('content-type')?.includes('multipart/form-data') ? await request.formData() : body.toString();
   const response = await provider.fetch(destination, init);
   res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(error.message); }
 });
 await new Promise(resolve => edge.listen(0,'127.0.0.1',resolve));
 t.after(() => new Promise(resolve => {edge.closeAllConnections();edge.close(resolve);}));
 const network = `http://127.0.0.1:${edge.address().port}`;
 let cli=join(base,'bin/rer.mjs');
 const command = async (...argv) => {
  try { return {code:0,...await run(process.execPath,['--import',join(base,'cli/fixtures/docs-search/network.mjs'),cli,...argv,'--site','--json','--no-queue'],{
   cwd:root,env:{PATH:process.env.PATH,HOME:join(directory,'home'),CI:'true',RER_NO_UPDATE_CHECK:'1',RER_TEST_NETWORK:network,CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token},maxBuffer:1024*1024})}; }
  catch(error) { return {code:error.code,stdout:error.stdout,stderr:error.stderr}; }
 };
 // Exercise the installed package as well as the source CLI.
 const archive=await readFile(await buildPackage(base,join(directory,'packed')));
 const packaged=join(directory,'package-host/node_modules/@runeditrun/rer');
 for(const entry of readPackage(archive,{integrity:integrity(archive)})) {
  const target=join(packaged,entry.path);
  await mkdir(dirname(target),{recursive:true}); await writeFile(target,entry.data);
 }
 let firstBytes;
 for (const executable of [cli,join(packaged,'bin/rer.mjs')]) {
  cli=executable;
  for (const argv of [['build'],['deploy','--dry-run']]) {
   const before=requests, result = await command(...argv);
   assert.equal(result.code,0,result.stdout+result.stderr);
   assert.equal(requests,before,'building and dry-run make zero outbound requests');
   const bytes=await readFile(join(root,'dist/site/docs-search-index.json'),'utf8');
   if (firstBytes) assert.equal(bytes,firstBytes,'unchanged input produces identical static index bytes');
   firstBytes=bytes;
   if (argv.includes('--dry-run')) {
    const plan=JSON.parse(result.stdout.trim().split('\n').at(-1)).result.site;
    assert.deepEqual(plan.bindings,['ASSETS']);
    assert.equal(plan.runtime.endpoint,'/docs-search-index.json');
    assert.equal(plan.runtime.bytes,Buffer.byteLength(bytes));
   }
  }
 }
 // The complete copied module has no undeclared sibling dependency.
 const copied=join(root,'module-only'); await cp(join(base,'modules/site/docs-search'),copied,{recursive:true});
 const helper=join(root,'copy-artifact.mjs');
 await writeFile(helper,`import {buildSearchArtifacts} from './module-only/artifacts.mjs'; await buildSearchArtifacts(${JSON.stringify({corpus:join(root,'.rer/docs-search/corpus.json'),assets:join(root,'dist/site'),output:join(directory,'module-output')})});`);
 const beforeCopy=requests;
 await run(process.execPath,['--import',join(base,'cli/fixtures/docs-search/network.mjs'),helper],{cwd:root,env:{PATH:process.env.PATH,RER_TEST_NETWORK:network}});
 assert.equal(requests,beforeCopy);
 assert.equal(await readFile(join(root,'dist/site/docs-search-index.json'),'utf8'),firstBytes);
 const deployed=await command('deploy'); assert.equal(deployed.code,0,deployed.stdout+deployed.stderr);
 assert.deepEqual(provider.state.version.resources.bindings,[{type:'assets',name:'ASSETS'}]);
 assert.ok(provider.state.calls.every(call=>!call.path.includes('/ai/')));
 const originalCorpus=JSON.parse(await readFile(join(root,'.rer/docs-search/corpus.json'),'utf8'));
 const previous=JSON.parse(firstBytes), unchanged=buildSearchIndex(originalCorpus,{previous});
 assert.equal(unchanged.counts.reindexed,0);
 const edited=structuredClone(originalCorpus); edited[0].searchSections[1].text+=' Select an archive from the recovery screen.';
 const changed=buildSearchIndex(edited,{previous}); assert.equal(changed.counts.reindexed,1);
 const restored=buildSearchIndex(originalCorpus,{previous:changed.index}); assert.equal(restored.counts.reindexed,1);
 assert.equal(restored.bytes,firstBytes);
 assert.throws(()=>createSearcher(changed.index,{version:previous.version,sourceHash:previous.sourceHash}),/mismatch/);
 assert.throws(()=>createSearcher({...previous,version:-1}),/mismatch/);
 const moduleBytes=provider.state.content.get(provider.state.version.id).files[0].bytes;
 const local=searchRuntime({source:moduleBytes.toString(),assets:join(root,'dist/site')}); t.after(()=>local.dispose());
 const runtime=createServer(async (req,res)=>{
  const response=await local.dispatchFetch('https://run-search.example.test'+req.url,{method:req.method});
  res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
 });
 await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{runtime.closeAllConnections();runtime.close(resolve);}));
 const origin=`http://127.0.0.1:${runtime.address().port}`;
 const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']}); t.after(()=>browser.close());
 for (const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:900}}), page=await context.newPage();
  const pageErrors=[], queryRequests=[]; let indexLoads=0;
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('request',request=>{ if(new URL(request.url()).searchParams.has('q')) queryRequests.push(request.url()); if(request.url().endsWith('/docs-search-index.json')) indexLoads++; });
  await page.goto(origin+'/docs/backups'); await page.keyboard.press('/');
  assert.equal(await page.getByRole('combobox').evaluate(el=>el===document.activeElement),true);
  await page.getByRole('status').filter({hasText:'Search the docs'}).waitFor();
  await page.getByRole('combobox').fill('restore backup'); const result=page.getByRole('option').first(); await result.waitFor();
  if(process.env.RER_SEARCH_EVIDENCE) await page.screenshot({path:join(process.env.RER_SEARCH_EVIDENCE,'search-results-'+width+'.png')});
  assert.deepEqual((await new AxeBuilder({page}).analyze()).violations,[]);
  for(const key of ['ArrowDown','ArrowDown','ArrowUp']) await page.getByRole('combobox').press(key);
  assert.equal(await page.getByRole('combobox').getAttribute('aria-activedescendant'),await result.getAttribute('id'));
  await page.getByRole('combobox').press('Escape'); assert.equal(await page.getByRole('combobox').getAttribute('aria-expanded'),'false');
  assert.equal(await page.getByRole('combobox').evaluate(el=>el===document.activeElement),true);
  await page.getByRole('combobox').press('ArrowDown'); assert.match(await result.getAttribute('href'),/\/docs\/backups#restore$/);
  if(width===1440) await result.click(); else await page.getByRole('combobox').press('Enter');
  await page.waitForURL('**/docs/backups#restore'); assert.equal(await page.locator('#restore').textContent(),'Restore a backup');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.env.RER_SEARCH_EVIDENCE) await page.screenshot({path:join(process.env.RER_SEARCH_EVIDENCE,'search-heading-'+width+'.png')});
  await page.getByRole('combobox').fill('zqxj vbwk plmoq'); await page.getByRole('status').filter({hasText:'No results'}).waitFor();
  assert.deepEqual((await new AxeBuilder({page}).analyze()).violations,[]);
  if(process.env.RER_SEARCH_EVIDENCE) await page.screenshot({path:join(process.env.RER_SEARCH_EVIDENCE,'search-negative-'+width+'.png')});
  assert.equal(indexLoads,1,'successive queries reuse the browser index'); assert.deepEqual(queryRequests,[]);
  assert.deepEqual(pageErrors,[]); await context.close();
  // A fresh client must refuse either mismatched source or corrupted bytes.
  const stale=await browser.newContext({viewport:{width,height:900}}), stalePage=await stale.newPage();
  await stalePage.route('**/docs-search-index.json',route=>route.fulfill({json:changed.index}));
  await stalePage.goto(origin+'/docs/backups'); await stalePage.getByRole('combobox').fill('restore backup');
  await stalePage.getByRole('status').filter({hasText:'Search unavailable'}).waitFor();
  assert.equal(await stalePage.getByRole('option').count(),0);
  if(process.env.RER_SEARCH_EVIDENCE) await stalePage.screenshot({path:join(process.env.RER_SEARCH_EVIDENCE,'search-mismatch-'+width+'.png')});
  assert.deepEqual((await new AxeBuilder({page:stalePage}).analyze()).violations,[]); await stale.close();
 }
});
