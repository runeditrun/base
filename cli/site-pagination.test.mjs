import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from './main.mjs';
import { exportReference } from '../scripts/export-reference.mjs';
import { siteProvider } from '../modules/deploy-kit/tests/site-provider.mjs';

async function fixture(t) {
 const directory = await mkdtemp(join(tmpdir(), 'rer-site-pagination-')), root = join(directory, 'seed');
 const saved = {...process.env}, provider = siteProvider();
 t.after(async () => {
  provider.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(directory, {recursive:true, force:true});
 });
 await exportReference(resolve(import.meta.dirname, '..'), root);
 await symlink(resolve(import.meta.dirname, '../default-seed/node_modules'), join(root, 'node_modules'), 'dir');
 await writeFile(join(root, 'src/site/pages.ts'), "export function sitePages() { return {pages:[{path:'/',html:'<h1>Site</h1><a href=\"/run\">Run</a>'},{path:'/run',html:'<h1>Run</h1>'}],assets:[]}; }");
 await writeFile(join(root, 'deploy-site.json'), JSON.stringify({version:1, domain:'run-example.test'}));
 // Keep the disposable checkout on this test process's runtime.
 const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 pkg.engines.node = process.versions.node;
 await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 Object.assign(process.env, {CI:'true', RER_NO_UPDATE_CHECK:'1', CLOUDFLARE_ACCOUNT_ID:provider.accountId, CLOUDFLARE_API_TOKEN:provider.token});
 t.mock.method(globalThis, 'fetch', provider.fetch);
 const run = async () => {
  let stdout = '', stderr = '';
  const out = t.mock.method(process.stdout, 'write', text => {stdout += text; return true;});
  const err = t.mock.method(process.stderr, 'write', text => {stderr += text; return true;});
  let code;
  try { code = await main(['deploy', '--site', '--cwd', root, '--no-queue']); }
  finally { out.mock.restore(); err.mock.restore(); }
  return {code, text:stdout + stderr};
 };
 const baseline = await run();
 assert.equal(baseline.code, 0, baseline.text);
 return {provider, run, root};
}

// Change only the network edge. Real provider pagination, settling, ownership,
// upload/readback, CLI exit status and human diagnostics remain in the path.
function changingList(t, provider, {list, phase = 'preflight', always = false}) {
 let uploaded = false, changed = false, starts = 0, secondPages = 0;
 const path = list === 'zones' ? '/zones' : list === 'domains' ? '/workers/domains' : `/${list}`;
 const field = list === 'versions' ? 'items' : list === 'deployments' ? 'deployments' : undefined;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input), method = init.method ?? 'GET';
  const response = await provider.fetch(input, init);
  if (method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(url.pathname)) uploaded = true;
  if (method !== 'GET' || !url.pathname.endsWith(path) || uploaded !== (phase === 'readback') || changed && !always) return response;
  const body = await response.json(), rows = field ? body.result[field] : body.result;
  const page = Number(url.searchParams.get('page') ?? 1);
  if (page === 1) starts++; else { secondPages++; changed = true; }
  const selected = page === 1 ? rows.slice(0, 1) : rows.slice(1);
  body.result = field ? {...body.result, [field]:selected} : selected;
  body.result_info = {page, per_page:100, total_pages:2, total_count:rows.length + (page === 1 ? 1 : 0)};
  return Response.json(body);
 });
 return {get starts() {return starts;}, get secondPages() {return secondPages;}};
}

for (const phase of ['preflight', 'readback']) for (const list of phase === 'preflight' ? ['zones', 'domains', 'deployments', 'versions'] : ['domains', 'deployments', 'versions']) {
 test(`rer deploy --site settles a one-time change in ${list} ${phase}`, async t => {
  const {provider, run, root} = await fixture(t);
  const calls = provider.state.calls.length, writes = provider.state.writes.length;
  const changed = changingList(t, provider, {list, phase});
  const result = await run();
  t.diagnostic(`exit=${result.code}; ${result.text.split('\n').find(line => line.includes('Run site deploy stopped:')) ?? 'site deploy completed'}`);
  assert.equal(result.code, 0, result.text);
  assert.equal(changed.secondPages, 1, 'the inconsistent snapshot reached page two once');
  assert.match(result.text, /Run site plan:/);
  assert.equal(provider.state.writes.slice(writes).filter(call => /^\/workers\/scripts\/[^/]+$/.test(call.path)).length, 1, 'settling never repeats the Worker upload');
  const observed = provider.state.calls.slice(calls);
  assert.ok(observed.some(call => call.method === 'GET' && call.path.endsWith('/deployments')), 'deployment readback completed');
  assert.ok(observed.some(call => call.method === 'GET' && call.path === '/workers/domains'), 'domain readback completed');
  const receipt = JSON.parse(await readFile(join(root, '.rer/deploy/site-production.json'), 'utf8'));
  assert.equal(receipt.hostnames.length, 2);
 });
}

test('rer deploy --site stops a list that keeps changing throughout the owner settling window', {timeout:150000}, async t => {
 const {provider, run} = await fixture(t), writes = provider.state.writes.length;
 const changed = changingList(t, provider, {list:'zones', always:true});
 const started = performance.now(), result = await run(), elapsed = performance.now() - started;
 const message = result.text.split('\n').find(line => line.includes('Run site deploy stopped:'));
 t.diagnostic(`exit=${result.code}; elapsed=${Math.round(elapsed)} ms; list attempts=${changed.starts}; ${message}`);
 assert.equal(result.code, 1, result.text);
 assert.match(message, /Run site deploy stopped: provider-pagination-changed/);
 assert.match(message, /GET \/zones.*page 2/);
 assert.ok(elapsed >= 119000, 'the existing 120-second window was used');
 assert.ok(changed.starts > 1 && changed.starts <= 33, 'bounded backoff limits relists');
 assert.equal(provider.state.writes.length, writes, 'an unsettled preflight authorizes no writes');
});
