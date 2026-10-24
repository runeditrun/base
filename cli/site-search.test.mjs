import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { exportReference } from '../scripts/export-reference.mjs';
import { siteProvider } from '../modules/deploy-kit/tests/site-provider.mjs';
import { sitePreview } from './site-preview.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');
const { chromium } = createRequire(join(base, 'default-seed/package.json'))('@playwright/test');

test('opt-in site prepares and reuses vectors, serves linked headings, and refuses publication on provider failure', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-site-search-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(join(directory, 'home'));
 await exportReference(base, root);
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 const adapter = join(root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('site: {', `site: { runtime: { type:'docs-search', module:'docs-search', bindings:['ASSETS','AI'], endpoint:'/docs/search', corpus:'.rer/docs-search/corpus.json' }, clients: { docsSearch:'scripts/base-cli/modules/site/docs-search/client.ts' },`));
 const pages = join(root, 'src/site/pages.tsx');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace("entry: 'src/site/pages.ts'", "entry: 'src/site/pages.tsx'"));
 const source = `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
 import {SearchField} from '../../scripts/base-cli/modules/site/docs-search/SearchField';
 export function sitePages({styles,clients}) {
  const text='Restore a backup by choosing the archive and reviewing its contents.';
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">'+styles.map(href=>'<link rel="stylesheet" href="'+href+'">').join('')+'<style>:root{--paper:#fff;--ink:#162122;--ink-soft:#586366;--rule:#ddd}body{font:18px system-ui;margin:24px;max-width:900px}.docs-search{max-width:320px}</style></head><body><nav>'+renderToStaticMarkup(createElement(SearchField,{id:'search'}))+'</nav><main><h1 id="backups">Backups</h1><h2 id="restore">Restore a backup</h2><p>'+text+'</p><a href="/run">Run</a><a href="/docs/search?q=restore">Search restore</a></main><script type="module" src="'+clients.docsSearch+'"></script></body></html>';
  return {pages:[{path:'/',html:'<a href="/run">Run</a><a href="/docs/backups">Backups</a>'},{path:'/run',html:'<h1>Run</h1>'},{path:'/docs/backups',html}],assets:[], searchPages:[{href:'/docs/backups',searchSections:[{anchor:'restore',titlePath:['Backups','Restore a backup'],text}]}]};
 }`;
 await writeFile(pages, source);
 const provider = siteProvider({ domain:'run-search.example.test' });
 t.after(() => provider.close());
 await writeFile(join(root, 'deploy-site.json'), JSON.stringify({version:1,domain:'run-search.example.test'}));
 let requests = 0, embeddings = 0, previous, failure = false, embeddingFailure = false;
 const vector = Array.from({length:768}, (_,i) => i === 0 ? 1 : 0);
 const edge = createServer(async (req, res) => {
  try {
   requests++;
   const destination = req.headers['x-test-destination'];
   const chunks=[]; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
   let response;
   if (destination === 'https://run-search.example.test/docs-search-vectors.json') response = failure ? new Response('Unavailable', {status:503}) : previous ? Response.json(previous) : new Response(null, {status:404});
   else if (destination.includes('/ai/run/')) {
    embeddings++;
    const input = JSON.parse(body.toString());
    response = failure || embeddingFailure ? new Response('Unavailable', {status:503}) : Response.json({success:true,result:{shape:[input.text.length,768],data:input.text.map(()=>vector)}});
   } else {
    const headers = new Headers(req.headers); headers.delete('host'); headers.delete('x-test-destination');
    const request = new Request(destination, {method:req.method,headers,...(req.method !== 'GET' ? {body} : {})});
    const init = {method:req.method,headers:{...Object.fromEntries(headers), Authorization:headers.get('authorization')}};
    if (req.method !== 'GET') init.body = headers.get('content-type')?.includes('multipart/form-data') ? await request.formData() : body.toString();
    response = await provider.fetch(destination, init);
   }
   res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(error.message); }
 });
 await new Promise(resolve => edge.listen(0,'127.0.0.1',resolve));
 t.after(() => new Promise(resolve => {edge.closeAllConnections();edge.close(resolve);}));
 const network = `http://127.0.0.1:${edge.address().port}`;
 const command = async (...argv) => {
  try { return {code:0,...await run(process.execPath,['--import',join(base,'cli/fixtures/docs-search/network.mjs'),join(base,'bin/rer.mjs'),...argv,'--site','--json','--no-queue'],{
   cwd:root,env:{PATH:process.env.PATH,HOME:join(directory,'home'),CI:'true',RER_NO_UPDATE_CHECK:'1',RER_TEST_NETWORK:network,CLOUDFLARE_ACCOUNT_ID:provider.accountId,CLOUDFLARE_API_TOKEN:provider.token},maxBuffer:1024*1024})}; }
  catch(error) { return {code:error.code,stdout:error.stdout,stderr:error.stderr}; }
 };
 for (const argv of [['build'],['deploy','--dry-run']]) {
  const result = await command(...argv);
  assert.equal(result.code,0,result.stdout+result.stderr);
  assert.match(result.stdout,/docs-search/);
 }
 assert.equal(requests,0,'build and dry run make zero network requests');
 await assert.rejects(readFile(join(root,'dist/site/docs-search-vectors.json')),{code:'ENOENT'});
 let deployed = await command('deploy');
 assert.equal(deployed.code,0,deployed.stdout+deployed.stderr);
 assert.ok(embeddings>0,'a first index uses Workers AI');
 for (const line of deployed.stdout.trim().split('\n')) JSON.parse(line);
 previous = JSON.parse(await readFile(join(root,'dist/site/docs-search-vectors.json'),'utf8'));
 const calls = embeddings;
 await rm(join(root,'.rer/docs-search'),{recursive:true});
 deployed = await command('deploy');
 assert.equal(deployed.code,0,deployed.stdout+deployed.stderr);
 assert.equal(embeddings,calls,'a clean runner reuses published vectors');
 assert.match(deployed.stderr,/reused=1 embedded=0/);
 const moduleBytes = provider.state.content.get(provider.state.version.id).files[0].bytes;
 const workerPath = join(directory,'published.mjs'); await writeFile(workerPath,moduleBytes);
 const {default:worker} = await import(pathToFileURL(workerPath));
 const preview = await sitePreview(join(root,'dist/site'),{ports:[0]});
 t.after(()=>preview.close());
 const assetOrigin = `http://127.0.0.1:${preview.port}`;
 const runtime = createServer(async (req,res) => {
  const response = await worker.fetch(new Request(`https://run-search.example.test${req.url}`,{method:req.method}),{
   ASSETS:{fetch:request=>fetch(assetOrigin+new URL(request.url).pathname)},
   AI:{run:async (model,input) => { const response=await fetch(network,{method:'POST',headers:{'x-test-destination':`https://api.cloudflare.com/ai/run/${model}`},body:JSON.stringify(input)}); if(!response.ok) throw Error('provider refused'); return (await response.json()).result; }},
  });
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
 await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{runtime.closeAllConnections();runtime.close(resolve);}));
 const origin=`http://127.0.0.1:${runtime.address().port}`;
 const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
 for (const width of [1440,390]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.goto(origin+'/docs/backups');
  await page.getByRole('combobox').fill('restore archive');
  const result=page.getByRole('option'); await result.waitFor();
  assert.match(await result.getAttribute('href'),/\/docs\/backups#restore$/);
  if (width === 1440) await result.click();
  else { await page.getByRole('combobox').press('ArrowDown'); await page.getByRole('combobox').press('Enter'); }
  await page.waitForURL('**/docs/backups#restore');
  assert.equal(await page.locator('#restore').textContent(),'Restore a backup');
  failure=true;
  await page.getByRole('combobox').fill('provider outage');
  await page.getByRole('status').filter({hasText:'Search unavailable'}).waitFor();
  await page.close(); failure=false;
 }
 const writes=provider.state.writes.length, version=provider.state.version.id;
 failure=true;
 deployed=await command('deploy');
 assert.notEqual(deployed.code,0,'a failed previous-index fetch refuses publication');
 assert.equal(provider.state.writes.length,writes); assert.equal(provider.state.version.id,version);
 failure=false; previous=undefined;
 await rm(join(root,'.rer/docs-search'),{recursive:true});
 // The REST embedding edge fails after the successful first-index 404.
 embeddingFailure=true;
 deployed=await command('deploy');
 assert.notEqual(deployed.code,0,'an embedding HTTP failure refuses publication');
 assert.equal(provider.state.writes.length,writes); assert.equal(provider.state.version.id,version);

});
