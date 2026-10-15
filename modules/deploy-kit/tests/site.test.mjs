import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare } from '../provider.mjs';
import { collectFiles } from '../artifact.mjs';
import { sitePlan, siteDeploy, siteDeclaration } from '../site.mjs';

const app = { project: 'runeditrun/cradle', environment: 'production', compatibilityDate: '2026-09-08' };

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
