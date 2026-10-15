import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from './main.mjs';
import { demoPlan } from '../modules/demo-host/plan.mjs';
import { demoAccount } from '../modules/demo-host/tests/demo-account.mjs';

// Public CLI dispatcher and flag parser through the demo removal; only Cloudflare's network edge is fake.
test('rer deploy --demo --remove --yes removes the demo its deploy recorded, by exact id, then is a no-op, and refuses what the record does not cover', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-demo-remove-')));
 let account = demoAccount(); const saved = { ...process.env };
 t.after(async () => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); await rm(root, { recursive: true, force: true }); });
 Object.assign(process.env, { CI: 'true', CLOUDFLARE_ACCOUNT_ID: account.accountId, CLOUDFLARE_API_TOKEN: account.token });
 let responseOverride = (_call, response) => response;
 const calls = [], requests = [];
 let interruptedDelete;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const call = `${init.method ?? 'GET'} ${new URL(input).pathname.replace(`/client/v4/accounts/${account.accountId}`, '')}`;
  calls.push(call);
  requests.push(call + new URL(input).search);
  if (call === interruptedDelete) return Response.json({ success: false, errors: [{ code: 10000, message: 'Deletion interrupted' }] }, { status: 503 });
  return responseOverride(call, await account.fetch(input, init));
 });
 const app = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', originVar: 'APP_ORIGIN', platforms: ['workers', 'container'] };
 const declaration = { version: 1, domain: 'test.run-fixture.test', name: 'Fixture' };
 await writeFile(join(root, 'deploy.json'), JSON.stringify(app));
 await writeFile(join(root, 'deploy-demo.json'), JSON.stringify(declaration));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.gitignore'), '.rer/\n.seed/\n');
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:{},hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy or remove the fixture demo in the fake Cloudflare account.' } } }));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const remove = (...flags) => main(['deploy', '--demo', '--remove', '--cwd', root, '--json', '--environment', 'demo-test', ...flags]);
 // The plan `rer deploy --demo --environment demo-test` deploys with `wrangler deploy --message <record>`.
 const plan = demoPlan({ project: app.project, environment: 'demo-test', compatibilityDate: app.compatibilityDate, originVar: app.originVar, declaration });
 const snapshot = () => JSON.stringify({ workers: [...account.state.workers.keys()], namespaces: account.state.namespaces, domains: account.state.domains, apps: account.state.apps });

 account.deploy(plan); account.unrelated();
 const before = snapshot();
 assert.equal(await remove(), 2, 'removal needs --yes');
 assert.equal(snapshot(), before);
 assert.equal(await remove('--yes'), 0);
 assert.deepEqual([...account.state.workers.keys()], ['someone-else'], 'the demo Worker is gone and the other Worker kept');
 assert.deepEqual(account.state.namespaces.map(row => row.script), ['someone-else'], 'its Durable Objects went with it');
 assert.deepEqual(account.state.domains.map(row => row.hostname), ['www.someone-else.test'], 'demo.test.run-fixture.test is gone');
 assert.deepEqual(account.state.apps.map(row => row.name), ['someone-else'], 'its Container application is gone');
 assert.ok(account.state.writes.every(write => /^DELETE \/workers\/domains\/[0-9a-f]{32}$|^DELETE \/containers\/applications\/[0-9a-f-]{36}$|^(PUT|DELETE) \/workers\/scripts\/fixture-demo-test--demo(\/schedules|\?force=true)$/.test(write)), `exact-id writes only: ${account.state.writes.join(', ')}`);

 // A second run finds nothing of the demo and writes nothing.
 account.state.writes.length = 0;
 assert.equal(await remove('--yes'), 0);
 assert.deepEqual(account.state.writes, []);

 // Cloudflare can confirm a DELETE with no JSON envelope. Each first invocation
 // must finish all three deletes and the readback, even with empty HTTP 200.
 for (const [status, body] of [[200, null], [200, ''], [202, null], [204, null]]) {
  account = demoAccount(); account.deploy(plan); account.unrelated(); calls.length = 0;
  responseOverride = (call, response) => call.startsWith('DELETE ') ? new Response(body, { status }) : response;
  assert.equal(await remove('--yes'), 0, `empty ${status} DELETE completes on its first run`);
  assert.deepEqual([...account.state.workers.keys()], ['someone-else']);
  assert.deepEqual(account.state.namespaces.map(row => row.script), ['someone-else']);
  assert.deepEqual(account.state.domains.map(row => row.hostname), ['www.someone-else.test']);
  assert.deepEqual(account.state.apps.map(row => row.name), ['someone-else']);
  const deletes = calls.filter(call => call.startsWith('DELETE '));
  assert.equal(deletes.length, 3, 'each owned resource is deleted once');
  assert.equal(new Set(deletes).size, 3, 'no DELETE is retried');
  const readback = calls.slice(calls.indexOf(`DELETE /workers/scripts/${plan.worker}`) + 1);
  for (const path of [`/workers/scripts/${plan.worker}/settings`, '/workers/durable_objects/namespaces', '/workers/domains', '/containers/applications']) {
   assert.ok(readback.includes(`GET ${path}`), `removal reads back ${path}`);
  }
  account.state.writes.length = 0;
  assert.equal(await remove('--yes'), 0, 'a repeat is a no-op');
  assert.deepEqual(account.state.writes, []);
 }

 // Only an actually empty successful DELETE has this meaning. Fail closed on
 // malformed bodies, refusals, HTTP errors and empty reads or schedule writes.
 for (const [method, status, body] of [
  ['DELETE', 200, 'not-json'], ['DELETE', 200, ' '], ['DELETE', 200, '{}'],
  ['DELETE', 200, '{"success":false,"errors":[]}'],
  ['DELETE', 202, '{"success":false,"errors":[]}'],
  ['DELETE', 200, '{"success":true,"result":null,"errors":[{"code":10000}]}'],
  ['DELETE', 403, null], ['DELETE', 500, null],
  ['GET', 200, null], ['GET', 204, null], ['PUT', 200, null], ['PUT', 204, null],
 ]) {
  account = demoAccount(); account.deploy(plan); account.unrelated(); calls.length = 0;
  const target = method === 'DELETE' ? `DELETE /workers/domains/${account.state.domains[0].id}`
   : method === 'PUT' ? `PUT /workers/scripts/${plan.worker}/schedules` : 'GET /workers/domains';
  responseOverride = (call, response) => call === target ? new Response(body, { status }) : response;
  assert.equal(await remove('--yes'), 1, `${method} ${status} with ${JSON.stringify(body)} fails`);
  assert.equal(calls.at(-1), target, 'removal stops at the rejected response');
  assert.equal(calls.filter(call => call === target).length, 1, 'the rejected request is not retried');
  assert.ok(account.state.workers.has(plan.worker), 'the demo Worker is retained after failure');
  assert.ok(account.state.workers.has('someone-else'), 'the unrelated Worker is retained');
  if (method === 'GET') assert.deepEqual(account.state.writes, [], 'empty inventory cannot authorize deletion');
  if (method === 'DELETE') assert.ok(account.state.apps.some(row => row.name === plan.container), 'no subsequent resource is deleted');
 }
 responseOverride = (_call, response) => response;

 // Anything the record does not cover is refused before the first delete.
 for (const extra of [
  () => account.domain('extra.test.run-fixture.test', plan.worker), // another hostname someone attached to the demo Worker
  () => account.app(plan.container, account.namespace('someone-else', 'Other').id), // a Container application of the demo's name on another namespace
  () => { account.state.workers.delete(plan.worker); account.worker(plan.worker, 'Deploy from the dashboard'); }, // a Worker of the demo's name serving no record
 ]) {
  account = demoAccount(); account.deploy(plan); account.unrelated(); extra();
  const kept = snapshot();
  assert.equal(await remove('--yes'), 1);
  assert.equal(snapshot(), kept, 'nothing was deleted');
  assert.deepEqual(account.state.writes, []);
 }

 // The same public remove door handles every declared domain. Keep the
 // single-host cases above to cover deployments made before secondary hosts.
 const secondary = 'page.demo.test.run-fixture.test';
 const multiApp = { ...app, container: { engine: 'workerd', hostVariables: ['PAGE_HOST', 'APP_HOST'] } };
 const multiDeclaration = { ...declaration, settings: { APP_HOST: 'demo.test.run-fixture.test', PAGE_HOST: secondary } };
 await writeFile(join(root, 'deploy.json'), JSON.stringify(multiApp));
 await writeFile(join(root, 'deploy-demo.json'), JSON.stringify(multiDeclaration));
 const multiPlan = demoPlan({ project: app.project, environment: 'demo-test', compatibilityDate: app.compatibilityDate,
  originVar: app.originVar, hostVariables: multiApp.container.hostVariables, declaration: multiDeclaration });
 account = demoAccount(); account.deploy(multiPlan); account.unrelated(); calls.length = 0; requests.length = 0;
 assert.equal(await remove('--yes'), 0);
 assert.deepEqual(account.state.domains.map(row => row.hostname), ['www.someone-else.test']);
 const domainDeletes = calls.filter(call => call.startsWith('DELETE /workers/domains/'));
 assert.equal(domainDeletes.length, multiPlan.hostnames.length);
 const workerDelete = `DELETE /workers/scripts/${multiPlan.worker}`;
 assert.equal(calls.filter(call => call.startsWith('DELETE ')).at(-1), workerDelete, 'the Worker is deleted last');
 const readback = requests.slice(requests.indexOf(workerDelete) + 1);
 for (const hostname of multiPlan.hostnames) assert.ok(readback.includes(`GET /workers/domains?hostname=${hostname}`), `read back ${hostname}`);
 account.state.writes.length = 0;
 assert.equal(await remove('--yes'), 0);
 assert.deepEqual(account.state.writes, []);

 // Collision, extra attachment, or a changed declared set cannot authorize
 // any deletion, including deletion of the primary domain.
 for (const change of [
  () => { account.state.domains.find(row => row.hostname === secondary).service = 'someone-else'; },
  () => account.domain(`extra.${multiPlan.hostname}`, multiPlan.worker),
  async () => writeFile(join(root, 'deploy-demo.json'), JSON.stringify({ ...multiDeclaration, settings: { ...multiDeclaration.settings, PAGE_HOST: `other.${multiPlan.hostname}` } })),
  () => account.state.workers.delete(multiPlan.worker),
 ]) {
  account = demoAccount(); account.deploy(multiPlan); account.unrelated(); await change();
  const kept = snapshot();
  assert.equal(await remove('--yes'), 1);
  assert.equal(snapshot(), kept);
  assert.deepEqual(account.state.writes, []);
  await writeFile(join(root, 'deploy-demo.json'), JSON.stringify(multiDeclaration));
 }

 // A failed second-domain deletion leaves the Worker ownership record for a
 // fresh invocation to finish removing the remaining domain and container.
 account = demoAccount(); account.deploy(multiPlan); account.unrelated();
 interruptedDelete = `DELETE /workers/domains/${account.state.domains.find(row => row.hostname === secondary).id}`;
 assert.equal(await remove('--yes'), 1);
 assert.ok(account.state.workers.has(multiPlan.worker));
 assert.deepEqual(account.state.domains.filter(row => row.service === multiPlan.worker).map(row => row.hostname), [secondary]);
 interruptedDelete = undefined;
 assert.equal(await remove('--yes'), 0);
 assert.deepEqual([...account.state.workers.keys()], ['someone-else']);
 assert.deepEqual(account.state.domains.map(row => row.hostname), ['www.someone-else.test']);
 assert.deepEqual(account.state.apps.map(row => row.name), ['someone-else']);
});
