import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { exportReference } from '../scripts/export-reference.mjs';
import { siteProvider } from '../modules/deploy-kit/tests/site-provider.mjs';
import { searchRuntime } from './fixtures/docs-search/runtime.mjs';
import { siteRateLimit } from '../modules/deploy-kit/site-runtime.mjs';

const run = promisify(execFile), base = resolve(import.meta.dirname, '..');
const { chromium } = createRequire(join(base, 'default-seed/package.json'))('@playwright/test');

test('opt-in site prepares and reuses vectors, serves linked headings, and refuses publication on provider failure', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-site-search-')), root = join(directory, 'seed');
 t.after(() => rm(directory, { recursive: true, force: true }));
 await mkdir(join(directory, 'home'));
 await exportReference(base, root);
 await symlink(join(base, 'default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 const adapter = join(root, 'scripts/installer/local.mjs');
 await writeFile(adapter, (await readFile(adapter, 'utf8')).replace('site: {', `site: { runtime: { type:'docs-search', module:'docs-search', bindings:['ASSETS','AI','SEARCH_RATE_LIMITER'], endpoint:'/docs/search', corpus:'.rer/docs-search/corpus.json' }, clients: { docsSearch:'scripts/base-cli/modules/site/docs-search/client.ts' },`));
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
 const local = searchRuntime({source:moduleBytes.toString(), assets:join(root,'dist/site'), network, rateLimit:siteRateLimit('test-site')});
 t.after(()=>local.dispose());
 const request = (query, visitor, options = {}) => local.dispatchFetch('https://run-search.example.test/docs/search?q='+encodeURIComponent(query), {headers:{'CF-Connecting-IP':visitor}, ...options});
 const measure = async (name, queries, visitor, parallel = false) => {
  const before = embeddings;
  const responses = parallel ? await Promise.all(queries.map(query=>request(query,visitor))) : await (async()=>{const rows=[]; for(const query of queries) rows.push(await request(query,visitor));return rows;})();
  const counts = {calls:embeddings-before, ok:responses.filter(row=>row.status===200).length, limited:responses.filter(row=>row.status===429).length};
  for (const response of responses) {
   assert.equal(response.headers.get('cache-control'),'no-store');
   if(response.status===429) { assert.equal(response.headers.get('retry-after'),'60'); assert.match((await response.json()).error,/Too many searches/); }
   else assert.equal(response.status,200);
  }
  console.log(name,JSON.stringify(counts)); return counts;
 };
 assert.deepEqual(await measure('repeated',Array.from({length:30},(_,i)=>i%2?'  RESTORE   ARCHIVE  ':'restore archive'),'192.0.2.1'),{calls:1,ok:30,limited:0});
 assert.deepEqual(await measure('distinct',Array.from({length:30},(_,i)=>'archive task '+i),'192.0.2.2'),{calls:10,ok:10,limited:20});
 assert.deepEqual(await measure('simultaneous repeated',Array(30).fill('simultaneous restore'),'192.0.2.3',true),{calls:1,ok:30,limited:0});
 assert.deepEqual(await measure('simultaneous distinct',Array.from({length:30},(_,i)=>'parallel task '+i),'192.0.2.4',true),{calls:10,ok:10,limited:20});
 const beforeBounds=embeddings;
 assert.equal((await request('x','192.0.2.5')).status,200);
 assert.equal((await request('x'.repeat(241),'192.0.2.5')).status,400);
 assert.equal((await request('archive','192.0.2.5',{method:'POST'})).status,405);
 assert.equal(embeddings,beforeBounds);
 failure=true;
 assert.equal((await request('uncached outage','192.0.2.5')).status,503);
 failure=false;
 assert.equal((await request('uncached outage','192.0.2.5')).status,200,'provider failures are not cached');
 // A second generated entry with a new corpus digest must not reuse the first
 // entry's cached result, even if the same location's Cache API survives.
 const {buildSiteRuntime}=await import('./site-runtime.mjs');
 const corpusFile=join(root,'.rer/docs-search/corpus.json');
 const corpus=JSON.parse(await readFile(corpusFile,'utf8'));
 corpus[0].searchSections[0].text+=' This archive has a newly published instruction.';
 await writeFile(corpusFile,JSON.stringify(corpus));
 const changed=await buildSiteRuntime({root}, {type:'docs-search',module:'docs-search',bindings:['ASSETS','AI','SEARCH_RATE_LIMITER'],endpoint:'/docs/search'},corpusFile,join(root,'dist/site'));
 assert.notEqual(changed.corpusHash,previous.corpusHash);
 const stale = searchRuntime({source:changed.source,assets:join(root,'dist/site'),network,rateLimit:siteRateLimit('stale-test')});
 t.after(()=>stale.dispose());
 const beforeStale=embeddings;
 const staleResponse=await stale.dispatchFetch('https://run-search.example.test/docs/search?q=restore+archive',{headers:{'CF-Connecting-IP':'192.0.2.7'}});
 assert.equal(staleResponse.status,503); assert.equal(embeddings,beforeStale,'stale corpus is rejected before inference');

 let browserVisitor='192.0.2.6';
 const runtime = createServer(async (req,res) => {
  const response = await local.dispatchFetch('https://run-search.example.test'+req.url,{method:req.method,headers:{'CF-Connecting-IP':browserVisitor}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
 await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{runtime.closeAllConnections();runtime.close(resolve);}));
 const origin=`http://127.0.0.1:${runtime.address().port}`;
 const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']}); t.after(()=>browser.close());
 for (const width of [1440,390]) {
  browserVisitor=width===1440?'192.0.2.6':'192.0.2.8';
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
  failure=false;
  for(let i=0;i<12;i++) await request('browser burst '+width+' '+i,browserVisitor);
  await page.getByRole('combobox').fill('limit message '+width);
  await page.getByRole('status').filter({hasText:'Too many searches. Try again in a minute.'}).waitFor();
  if(process.env.RER_SEARCH_EVIDENCE) await page.screenshot({path:join(process.env.RER_SEARCH_EVIDENCE,'search-rate-limit-'+width+'.png')});
  await page.close();
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
