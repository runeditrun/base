import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cloudflare } from '../provider.mjs';
import { collectFiles } from '../artifact.mjs';
import { sitePlan, siteDeploy, siteDeclaration, siteReadbackSummary } from '../site.mjs';
import * as siteKit from '../site.mjs';
import { hash } from '../validation.mjs';
import { siteRateLimit } from '../site-runtime.mjs';

const app = { project: 'runeditrun/cradle', environment: 'production', compatibilityDate: '2026-09-08' };

function searchRuntime(overrides = {}) {
  const contract = { corpusHash: hash('search corpus'), model: '@cf/baai/bge-base-en-v1.5', pooling: 'cls' };
  return { type: 'docs-search', module: 'docs-search', endpoint: '/docs/search', bindings: ['ASSETS', 'AI', 'SEARCH_RATE_LIMITER'], ...contract,
    source: `const contract = ${JSON.stringify(contract)}; export default { fetch(request, env) { return env.ASSETS.fetch(request); } };`, ...overrides };
}

async function site(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-site-deploy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'dist/site');
  await mkdir(join(folder, 'brand'), { recursive: true });
  await writeFile(join(folder, 'index.html'), '<!doctype html><a href="/run">Run</a>');
  await writeFile(join(folder, 'run.html'), '<!doctype html><h1>Run</h1>');
  await writeFile(join(folder, 'brand/mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { root, folder, files: await collectFiles(folder), receiptPath: join(root, '.rer/deploy/site-production.json') };
}

test('a run site declaration names only an apex domain, and its plan never names the app Worker', () => {
  for (const domain of ['https://run-cradle.com', 'run-cradle.com/run', 'run-cradle.com:443', 'www.run-cradle.com', 'Run-Cradle.com', 'localhost', ''])
    assert.throws(() => siteDeclaration({ version: 1, domain }), /invalid-site-domain/, domain);
  assert.throws(() => siteDeclaration({ version: 1, domain: 'run-cradle.com', worker: 'x' }), /invalid-site-declaration/);
  const plan = sitePlan({ ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: '/checkout/dist/site' });
  assert.notEqual(plan.worker, plan.appWorker);
  assert.deepEqual([plan.bindings, plan.secrets, plan.crons], [['ASSETS'], [], []]);
  assert.deepEqual(plan.hostnames, ['run-cradle.com', 'www.run-cradle.com']);
  assert.deepEqual(plan.redirects.map(({ from, to, status }) => ({ from, to, status })), [{ from: 'https://www.run-cradle.com/*', to: 'https://run-cradle.com/', status: 301 }]);
  // No app environment name can produce the site Worker's name.
  for (const environment of ['production', 'site', 'production-site', 'site-production']) assert.notEqual(sitePlan({ ...app, environment, declaration: { version: 1, domain: 'run-cradle.com' }, assets: '/x' }).worker, sitePlan({ ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: '/x' }).appWorker);
});

test('site fingerprints preserve assets-only identity and bind search code, model, corpus and vector bytes', () => {
  const options = { ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: '/checkout/dist/site' };
  const plain = sitePlan(options), files = [{ path: 'index.html', sha256: hash('home') }, { path: 'docs-search-vectors.json', sha256: hash('vectors') }];
  assert.equal(siteKit.siteFingerprint(plain, files), hash({ files, config: plain.assetsConfig, module: hash(siteKit.SITE_WORKER), compatibilityDate: plain.compatibilityDate }));
  const runtime = searchRuntime(), search = sitePlan({ ...options, runtime });
  assert.deepEqual(search.bindings, ['ASSETS', 'AI', 'SEARCH_RATE_LIMITER']);
  assert.deepEqual(search.runtime, runtime);
  const fingerprint = siteKit.siteFingerprint(search, files);
  assert.notEqual(fingerprint, siteKit.siteFingerprint(plain, files));
  for (const change of [{ source: `${runtime.source}\n// rebuilt` }, { model: '@cf/baai/bge-large-en-v1.5' }, { corpusHash: hash('new corpus') }])
    assert.notEqual(siteKit.siteFingerprint(sitePlan({ ...options, runtime: searchRuntime(change) }), files), fingerprint);
  assert.notEqual(siteKit.siteFingerprint(search, files.map(file => file.path === 'docs-search-vectors.json' ? { ...file, sha256: hash('new vectors') } : file)), fingerprint);
  assert.throws(() => siteKit.siteFingerprint(search, files.slice(0, 1)), /missing-site-search-vectors/);
  for (const change of [{ type: 'custom' }, { bindings: ['ASSETS', 'AI'] }, { bindings: ['ASSETS', 'AI', 'DB'] }, { endpoint: '/custom' }, { annotations: {} }, { pooling: 'mean' }])
    assert.throws(() => sitePlan({ ...options, runtime: searchRuntime(change) }), /invalid-site-runtime/);
});

test('search deploy uploads the generated runtime and verifies exact serving version modules and AI bindings', async t => {
  const { siteProvider } = await import('./site-provider.mjs');
  for (const scenario of ['search upload', 'missing AI', 'missing ASSETS', 'missing limiter', 'wrong namespace', 'wrong limit', 'wrong period', 'wrong AI type', 'extra binding', 'module changed', 'model changed', 'pooling changed', 'corpus changed', 'wrong entry', 'extra module', 'settings differ', 'final readback changed']) await t.test(scenario, async t => {
    const provider = siteProvider({ domain: 'run-cradle.com' }), { folder, receiptPath } = await site(t);
    t.after(() => provider.close());
    await writeFile(join(folder, 'docs-search-vectors.json'), JSON.stringify({ model: '@cf/baai/bge-base-en-v1.5', pooling: 'cls', corpusHash: hash('search corpus'), chunks: [] }));
    const runtime = searchRuntime();
    const plan = sitePlan({ ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: folder, runtime });
    const api = cloudflare({ accountId: provider.accountId, token: provider.token, fetch: provider.fetch });
    let uploadedVersion;
    const observed = { ...api, async request(path, options) {
      const result = await api.request(path, options);
      if (path === `/workers/scripts/${plan.worker}` && options?.method === 'PUT') {
        uploadedVersion = provider.state.version.id;
        const bindings = provider.state.version.resources.bindings;
        const content = provider.state.content.get(uploadedVersion);
        if (scenario === 'missing AI') provider.state.version.resources.bindings = bindings.filter(binding => binding.name !== 'AI');
        if (scenario === 'missing ASSETS') provider.state.version.resources.bindings = bindings.filter(binding => binding.name !== 'ASSETS');
        if (scenario === 'missing limiter') provider.state.version.resources.bindings = bindings.filter(binding => binding.name !== 'SEARCH_RATE_LIMITER');
        if (scenario === 'wrong namespace') bindings.find(binding => binding.name === 'SEARCH_RATE_LIMITER').namespace_id = '1';
        if (scenario === 'wrong limit') bindings.find(binding => binding.name === 'SEARCH_RATE_LIMITER').simple.limit++;
        if (scenario === 'wrong period') bindings.find(binding => binding.name === 'SEARCH_RATE_LIMITER').simple.period = 10;
        if (scenario === 'wrong AI type') bindings.find(binding => binding.name === 'AI').type = 'plain_text';
        if (scenario === 'extra binding') bindings.push({ type: 'plain_text', name: 'UNEXPECTED', text: 'value' });
        if (scenario === 'module changed') content.files[0].bytes = Buffer.from(`${runtime.source}\n// changed`);
        if (scenario === 'model changed') content.files[0].bytes = Buffer.from(runtime.source.replace(runtime.model, '@cf/baai/bge-large-en-v1.5'));
        if (scenario === 'pooling changed') content.files[0].bytes = Buffer.from(runtime.source.replace('cls', 'mean'));
        if (scenario === 'corpus changed') content.files[0].bytes = Buffer.from(runtime.source.replace(runtime.corpusHash, hash('different corpus')));
        if (scenario === 'wrong entry') { content.files[0].path = 'other.mjs'; content.entry = 'other.mjs'; }
        if (scenario === 'extra module') content.files.push({ path: 'other.mjs', type: 'application/javascript+module', bytes: Buffer.from('export default {};') });
        if (scenario === 'settings differ') provider.state.settings.bindings = [];
      }
      if (scenario === 'final readback changed' && path.endsWith('/subdomain')) provider.state.content.get(uploadedVersion).files[0].bytes = Buffer.from(`${runtime.source}\n// changed`);
      return result;
    } };
    const run = async () => siteDeploy({ api: observed, plan, files: await collectFiles(folder), receiptPath });
    if (scenario === 'search upload' || scenario === 'settings differ') {
      const result = await run();
      assert.equal(result.origin, 'https://run-cradle.com');
      assert.equal(provider.state.content.get(uploadedVersion).files[0].bytes.toString(), runtime.source);
      assert.deepEqual(provider.state.version.resources.bindings, [{ type: 'assets', name: 'ASSETS' }, { type: 'ai', name: 'AI' }, siteRateLimit(plan.worker)]);
      assert.ok(provider.state.calls.some(call => call.path.endsWith('/content/v2') && call.search.includes(uploadedVersion)), 'reads content of uploaded serving version');
      assert.equal(provider.state.settings.main_module, siteKit.SITE_MODULE);
    } else {
      await assert.rejects(run(), /owned-resource-replaced/, scenario);
      assert.equal(provider.state.domains.length, scenario === 'final readback changed' ? 2 : 0, 'both Worker readbacks enforce the runtime');
      await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
    }
  });
});

test('search deploy waits for the uploaded runtime instead of checking an older serving runtime, and waits for its version content visibility', async t => {
  const { siteProvider } = await import('./site-provider.mjs');
  for (const scenario of ['previous runtime', 'missing content']) await t.test(scenario, async t => {
    const provider = siteProvider({ domain: 'run-cradle.com' }), { folder, receiptPath } = await site(t);
    t.after(() => provider.close());
    const api = cloudflare({ accountId: provider.accountId, token: provider.token, fetch: provider.fetch });
    const options = { ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: folder };
    await siteDeploy({ api, plan: sitePlan(options), files: await collectFiles(folder), receiptPath });
    const deployments = structuredClone(provider.state.deployments);
    await writeFile(join(folder, 'docs-search-vectors.json'), JSON.stringify({ corpusHash: hash('search corpus') }));
    let uploaded = false, lagging = 0, elapsed = 0, sleeps = 0;
    const observed = cloudflare({ accountId: provider.accountId, token: provider.token, fetch: async (input, init = {}) => {
      const response = await provider.fetch(input, init), url = new URL(input);
      if (init.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(url.pathname)) uploaded = true;
      if (uploaded && scenario === 'previous runtime' && url.pathname.endsWith('/deployments') && ++lagging <= 2)
        return Response.json({ success: true, errors: [], result: { deployments } });
      if (uploaded && scenario === 'missing content' && url.pathname.endsWith('/content/v2') && ++lagging <= 2)
        return Response.json({ success: false, errors: [{ code: 100146, message: 'Version not found' }] }, { status: 404 });
      return response;
    } });
    const writes = provider.state.writes.length;
    const result = await siteDeploy({ api: observed, plan: sitePlan({ ...options, runtime: searchRuntime() }), files: await collectFiles(folder), receiptPath,
      readiness: { totalMs: 9000, clock: () => elapsed, sleep: async ms => { elapsed += ms; sleeps++; } } });
    assert.equal(result.origin, 'https://run-cradle.com');
    assert.equal(sleeps, 2);
    assert.ok(lagging >= 3);
    assert.equal(provider.state.writes.slice(writes).filter(write => write.path === `/workers/scripts/${result.receipt.worker}`).length, 1);
  });
});

// Ownership is read from the provider: a fresh checkout (a CI runner, no .rer/)
// deploys again over the site it deployed before. No zone ruleset is touched,
// so a token without Single Redirect permission (every ruleset path 403) works.
test('site deploy uploads the generated site Worker, attaches the apex and www, and deploys again from a fresh checkout without new resources', async t => {
  const { siteProvider } = await import('./site-provider.mjs');
  const provider = siteProvider({ domain: 'run-cradle.com' }), { root, files, folder, receiptPath } = await site(t);
  t.after(() => provider.close());
  const api = cloudflare({ accountId: provider.accountId, token: provider.token, fetch: async (input,init) => {
    const response = await provider.fetch(input,init), url = new URL(input);
    if (init.method !== 'GET' || !/\/(zones|domains|versions|deployments)$/.test(url.pathname)) return response;
    const body = await response.json(), second = url.searchParams.get('page') === '2';
    const field = url.pathname.endsWith('/versions') ? 'items' : url.pathname.endsWith('/deployments') ? 'deployments' : undefined;
    const rows = field ? body.result[field] : body.result;
    if (!Array.isArray(rows)) return Response.json(body);
    if (!second) { if (field) body.result[field] = []; else body.result = []; }
    body.result_info = {page:second ? 2 : 1,total_pages:2};
    return Response.json(body);
  }});
  const plan = sitePlan({ ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: folder });
  const first = await siteDeploy({ api, plan, files, receiptPath });
  assert.ok(provider.state.calls.some(call => call.path === '/zones' && call.search.includes('page=2')), 'zone filters survive continuation');
  assert.ok(provider.state.calls.some(call => call.path.endsWith('/versions') && call.search.includes('page=2')), 'versions are completely read');
  assert.equal(first.origin, 'https://run-cradle.com');
  assert.equal(provider.state.settings.main_module, 'site-worker.mjs');
  assert.deepEqual(provider.state.settings.bindings, [{ type: 'assets', name: 'ASSETS' }]);
  assert.deepEqual(provider.state.settings.assets.config, { html_handling: 'auto-trailing-slash', not_found_handling: '404-page', run_worker_first: true });
  assert.deepEqual(provider.state.domains.map(row => [row.hostname, row.service]), [['run-cradle.com', plan.worker], ['www.run-cradle.com', plan.worker]]);
  assert.ok(!provider.state.calls.some(call => call.path.includes(`/${plan.appWorker}`) && !call.path.includes(`/${plan.worker}`)), 'the app Worker is never read or written');
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).worker, plan.worker);
  await rm(join(root, '.rer'), { recursive: true });
  await writeFile(join(folder, 'run.html'), '<!doctype html><h1>Run it</h1>');
  const writes = provider.state.writes.length;
  await siteDeploy({ api, plan, files: await collectFiles(folder), receiptPath });
  const repeated = provider.state.writes.slice(writes).map(write => write.path);
  assert.ok(repeated.includes(`/workers/scripts/${plan.worker}`), 'the changed site is uploaded');
  assert.ok(!repeated.includes('/workers/domains'), 'a repeat attaches no domain');
  assert.equal(provider.state.domains.length, 2);
  assert.ok(!provider.state.calls.some(call => call.path.includes('/rulesets')), 'no zone ruleset is read or written');
});

test('site deploy refuses a Worker or domain it did not make, a rolled-back Worker and a domain with no zone in the account, before any write', async t => {
  const { siteProvider } = await import('./site-provider.mjs');
  const declaration = { version: 1, domain: 'run-cradle.com' };
  for (const [name, arrange, code] of [
    ['foreign www domain', provider => provider.foreignDomain('www.run-cradle.com'), 'resource-name-collision'],
    ['foreign worker of the same name', provider => provider.foreignWorker(), 'resource-name-collision'],
    ['apex bound to another service', null, 'resource-name-collision'],
    ['latest deployment is a dashboard rollback', null, 'owned-resource-replaced'],
    ['no zone in this account', null, 'site-zone-missing'],
  ]) {
    const provider = siteProvider({ domain: 'run-cradle.com', zone: name !== 'no zone in this account' }), { files, folder, receiptPath } = await site(t);
    t.after(() => provider.close());
    const api = cloudflare({ accountId: provider.accountId, token: provider.token, fetch: provider.fetch });
    const plan = sitePlan({ ...app, declaration, assets: folder });
    arrange?.(provider);
    if (name === 'apex bound to another service') { await siteDeploy({ api, plan, files, receiptPath }); provider.state.domains[0].service = 'someone-elses-worker'; }
    if (name === 'latest deployment is a dashboard rollback') {
      await siteDeploy({ api, plan, files, receiptPath });
      await writeFile(join(folder, 'run.html'), '<!doctype html><h1>Run it</h1>');
      await siteDeploy({ api, plan, files: await collectFiles(folder), receiptPath });
      provider.rollback();
    }
    const writes = provider.state.writes.length;
    await assert.rejects(siteDeploy({ api, plan, files, receiptPath }), new RegExp(code), name);
    assert.equal(provider.state.writes.length, writes, `${name}: no provider write`);
  }
});

test('site upload waits for its own version through lagging provider reads without accepting replacements', async t => {
  const { siteProvider } = await import('./site-provider.mjs');
  for (const scenario of ['deployments', 'versions', 'missing deployments', 'missing version', 'fresh Worker missing', 'final readback', 'timeout', 'foreign version', 'foreign newest', 'foreign fingerprint', 'foreign owner', 'split deployment']) await t.test(scenario, async t => {
    const provider = siteProvider({ domain: 'run-cradle.com' }), { files, folder, receiptPath } = await site(t);
    t.after(() => provider.close());
    const api = cloudflare({ accountId: provider.accountId, token: provider.token, fetch: provider.fetch });
    const plan = sitePlan({ ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: folder });
    const fresh = scenario === 'fresh Worker missing';
    if (!fresh) await siteDeploy({ api, plan, files, receiptPath });
    const priorDeployments = structuredClone(provider.state.deployments);
    const priorVersions = structuredClone(provider.state.versions ?? []);
    const receipt = fresh ? null : await readFile(receiptPath), writes = provider.state.writes.length;
    let uploaded = false, reads = 0, elapsed = 0, sleeps = 0, final = false;
    const observed = { ...api, async request(path, options) {
      const result = await api.request(path, options);
      if (path === `/workers/scripts/${plan.worker}` && options?.method === 'PUT') {
        uploaded = true;
        if (scenario === 'foreign version') {
          provider.state.version.id = randomUUID();
          provider.state.deployments[0].versions[0].version_id = provider.state.version.id;
        }
        if (scenario === 'foreign fingerprint') provider.state.version.annotations['workers/message'] = `rer-site:${'f'.repeat(64)}`;
        if (scenario === 'foreign owner') provider.state.version.annotations['workers/message'] = 'Deploy from the dashboard';
        if (scenario === 'foreign newest') provider.state.versions = [{ id: randomUUID() }, ...provider.state.versions];
        if (scenario === 'split deployment') provider.state.deployments[0].versions.push({ version_id: priorVersions[0].id, percentage: 0 });
      }
      if (!uploaded) return result;
      if (fresh && path.endsWith('/settings') && ++reads <= 2) throw Object.assign(new Error('provider-http-404'), { status: 404 });
      if (path.endsWith('/subdomain')) final = true;
      if (!fresh && path.endsWith('/deployments') && (scenario !== 'final readback' || final)) {
        reads++;
        if ((scenario === 'deployments' || scenario === 'final readback') && reads <= 2 || scenario === 'timeout') return { deployments: priorDeployments };
        if (scenario === 'missing deployments' && reads <= 2) return { deployments: [] };
      }
      if (path.endsWith('/versions') && scenario === 'versions' && reads <= 2) return { items: priorVersions.map(({ id }) => ({ id })) };
      if (path.includes('/versions/') && scenario === 'missing version' && reads <= 2) throw Object.assign(new Error('provider-http-404'), { status: 404 });
      return result;
    } };
    const readiness = { totalMs: 9000, clock: () => elapsed, sleep: async ms => { sleeps++; elapsed += ms; } };
    const run = () => siteDeploy({ api: observed, plan, files, receiptPath, readiness });
    if (scenario.startsWith('foreign') || scenario === 'split deployment') {
      await assert.rejects(run(), /owned-resource-replaced/);
      assert.equal(sleeps, 0, 'a real replacement is refused without a retry');
      assert.deepEqual(await readFile(receiptPath), receipt);
    } else if (scenario === 'timeout') {
      await assert.rejects(run(), error => error.message === 'site-upload-timeout' && error.lastSeen.versionId === priorVersions[0].id && siteReadbackSummary(error).includes(priorVersions[0].id));
      assert.equal(elapsed, readiness.totalMs, 'readback shares the original upload deadline');
      assert.deepEqual(await readFile(receiptPath), receipt);
    } else {
      assert.equal((await run()).origin, 'https://run-cradle.com');
      assert.equal(reads >= 3, true, 'two lagging reads are followed by the uploaded version');
      assert.equal(sleeps, 2);
      assert.ok(elapsed > 0 && elapsed < readiness.totalMs);
    }
    assert.equal(provider.state.writes.slice(writes).filter(write => write.path === `/workers/scripts/${plan.worker}`).length, 1, 'only readback is retried');
  });
});

test('site deploy polls the zone domain list within the readiness window: a lagging list succeeds, a hostname never listed fails at the deadline naming it, another Worker fails at once', async t => {
  const { siteProvider } = await import('./site-provider.mjs');
  for (const scenario of ['lags two polls', 'never lists www', 'bound to another Worker']) await t.test(scenario, async t => {
    const provider = siteProvider({ domain: 'run-cradle.com' }), { files, folder, receiptPath } = await site(t);
    t.after(() => provider.close());
    let attached = false, lists = 0, elapsed = 0, sleeps = 0;
    const fetch = async (input, init = {}) => {
      const response = await provider.fetch(input, init), url = new URL(input);
      if (!url.pathname.endsWith('/workers/domains')) return response;
      if (init.method === 'PUT') { attached = true; return response; }
      if (!attached) return response;
      const body = await response.json();
      if (scenario === 'bound to another Worker') body.result = body.result.map(row => row.hostname === 'www.run-cradle.com' ? { ...row, service: 'someone-elses-worker' } : row);
      else if (scenario === 'never lists www') body.result = body.result.filter(row => row.hostname !== 'www.run-cradle.com');
      else if (++lists <= 2) body.result = [];
      return Response.json(body);
    };
    const api = cloudflare({ accountId: provider.accountId, token: provider.token, fetch });
    const plan = sitePlan({ ...app, declaration: { version: 1, domain: 'run-cradle.com' }, assets: folder });
    const readiness = { totalMs: 9000, clock: () => elapsed, sleep: async ms => { sleeps++; elapsed += ms; } };
    const run = () => siteDeploy({ api, plan, files, receiptPath, readiness });
    if (scenario === 'lags two polls') {
      assert.equal((await run()).origin, 'https://run-cradle.com');
      assert.ok(lists >= 3, 'two empty lists are followed by the attached hostnames');
    } else {
      await assert.rejects(run(), error => error.message === 'domain-readback-mismatch' && error.resource === 'domain:www.run-cradle.com');
      if (scenario === 'never lists www') assert.equal(elapsed, readiness.totalMs, 'the wait ends at the deploy deadline');
      else assert.equal(sleeps, 0, 'a foreign Worker is refused without a retry');
    }
  });
});
