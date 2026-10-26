import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { isolatedQueue } from './fixtures/queue.mjs';
import { demoPreflight } from './demo.mjs';
import { resolveProject } from './project.mjs';
import { developmentTarget } from '../onboarding/operator-installer.mjs';
import { demoSockets } from '../modules/demo/vite.mjs';

const execute = promisify(execFile);

// Exercise the public CLI and real Vite/Cloudflare native packaging. No build
// stub supplies the bundle or generated deployment configuration.
test('rer deploy --demo --dry-run packages declared public hosts and refuses unsafe declarations', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-demo-plan-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const primary = 'demo.test.run-fixture.test', page = `page.${primary}`, status = `status.${primary}`;
 const app = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', originVar: 'APP_ORIGIN',
  platforms: ['workers'], container: { hostVariables: ['STATUS_HOST', 'APP_HOST', 'PAGE_HOST', 'PAGE_ALIAS'] } };
 const declaration = { version: 1, domain: 'test.run-fixture.test', name: 'Fixture', instanceType: 'standard-1', runUrl: 'https://run-fixture.test/run',
  settings: { APP_HOST: primary, PAGE_HOST: page, PAGE_ALIAS: page, STATUS_HOST: status, UNROUTED_HOST: 'outside.example.test' } };
 const configure = async (demo = declaration, deploy = app) => {
  await writeFile(join(root, 'owner-deployment.json'), JSON.stringify(deploy));
  await writeFile(join(root, 'deploy-demo.json'), JSON.stringify(demo));
 };
 await configure();
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.gitignore'), '.rer/\n.seed/\n.wrangler/\nnode_modules/\ndist/\n');
 await mkdir(join(root, 'src'));
 await mkdir(join(root, 'public'));
 await writeFile(join(root, 'public/asset.txt'), 'public asset');
 await mkdir(join(root, 'migrations'));
 await writeFile(join(root, 'migrations/0001.sql'), 'CREATE TABLE items(id TEXT);');
 await symlink(resolve(import.meta.dirname, '../default-seed/node_modules'), join(root, 'node_modules'));
 await writeFile(join(root, 'src/client.js'), 'console.log(42)');
 await writeFile(join(root, 'src/server.ts'), "export default {fetch(request) { return Response.json({ok:true,origin:new URL(request.url).origin}); }};");
 await writeFile(join(root, 'vite.config.mjs'), `
  import {cloudflare} from '@cloudflare/vite-plugin';
  import {demoSockets} from ${JSON.stringify(new URL('../modules/demo/vite.mjs', import.meta.url).href)};
  export default {logLevel:'silent',plugins:[demoSockets(),cloudflare({persistState:{path:process.env.RER_STATE_DIR ?? '.wrangler/state'},viteEnvironment:{name:'ssr'}})],
   environments:{ssr:{build:{outDir:'dist/server'}},client:{build:{outDir:'dist/client',rolldownOptions:{input:'src/client.js'}}}},
   builder:{buildApp:async builder=>{await builder.build(builder.environments.client);await builder.build(builder.environments.ssr);}}};
 `);
 await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'demo-plan-fixture', main: 'src/server.ts', compatibility_date: app.compatibilityDate, assets: {directory:'public',binding:'ASSETS'}, d1_databases:[{binding:'DB',database_name:'fixture',database_id:'00000000-0000-0000-0000-000000000001',migrations_dir:'migrations'}] }));
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:[],hooks:{}};
 export const commandAdapter = {...lifecycle,site:{declaration:'config/site.json'},deploy:ownerDeploy('owner-deployment.json',lifecycle)};`);
 await mkdir(join(root, 'config'));
 await writeFile(join(root, 'config/site.json'), JSON.stringify({ version: 1, domain: 'run-fixture.test' }));
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'],
   inputs: ['adapter.mjs', 'owner-deployment.json'], effects: 'Plan the fixture demo.' } } }));
 const env = await isolatedQueue(t);
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const rer = async () => {
  try { return { code: 0, ...await execute(process.execPath, [new URL('../bin/rer.mjs', import.meta.url).pathname, 'deploy', '--demo', '--dry-run', '--json'],
   { cwd: root, encoding: 'utf8', env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_NO_UPDATE_CHECK: '1' }, timeout: 120000, maxBuffer: 1024 * 1024 }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
 };
 const localExit = async (command = 'serve') => {
  const project = await resolveProject(root);
  const demo = await demoPreflight(project, {OWNER_EMAIL: 'demo-owner@example.test', AUTH_ORIGIN: 'http://127.0.0.1:3210'}, 3600);
  const [, , {env}] = developmentTarget({root, origin: 'http://127.0.0.1:3210', runtimePort: 3211, demo});
  const previous = process.env.RER_DEMO_RUN_URL;
  process.env.RER_DEMO_RUN_URL = env.RER_DEMO_RUN_URL;
  try { return JSON.parse((await demoSockets().config({root}, {command})).define['import.meta.rerDemo']); }
  finally { if (previous === undefined) delete process.env.RER_DEMO_RUN_URL; else process.env.RER_DEMO_RUN_URL = previous; }
 };
 const built = await rer();
 assert.equal(built.code, 0, built.stdout + built.stderr);
 const config = JSON.parse(await readFile(join(root, '.rer/demo-host/wrangler.json'), 'utf8'));
 const hostnames = [primary, page, status];
 assert.deepEqual(config.routes, hostnames.map(pattern => ({ pattern, custom_domain: true })));
 assert.deepEqual(JSON.parse(config.vars.DEMO_SECONDARY_ORIGINS), [`https://${page}`, `https://${status}`]);
 assert.deepEqual(JSON.parse(config.vars.DEMO_SETTINGS), declaration.settings);
 assert.equal(config.containers, undefined);
 assert.equal(config.durable_objects.bindings.find(row => row.name === 'DEMO').class_name, 'NativeDemo');
 const manifest = JSON.parse(await readFile(join(root, '.rer/demo-host/bundle/app/demo.json'), 'utf8'));
 assert.ok(manifest.migrations.DB.length, 'declared SQL is included in the native bundle');
 assert.ok((await readFile(join(root, '.rer/demo-host/modules/demo-host/native/bundle.mjs'), 'utf8')).includes('app/'), 'the real build emitted the packaged Worker entry');
 const summary = built.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.event === 'demo');
 assert.deepEqual(summary.hostnames, hostnames);
 assert.deepEqual(summary.routes, config.routes);

 // The template's own "Scope the test host" step, run on the production declaration, yields this one: the secondary hosts move under demo.test.
 const step = (await readFile(new URL('../export/run-demo.yml', import.meta.url), 'utf8')).match(/- name: Scope the test host\n(?:.*\n)*?\s+run: \|\n((?: {10}.*\n)+)/)[1].replace(/^ {10}/gm, '');
 await configure({ ...JSON.parse(JSON.stringify(declaration).replaceAll('demo.test.', 'demo.')), domain: 'run-fixture.test' });
 await execute('bash', ['-c', step], { cwd: root });
 assert.deepEqual(JSON.parse(await readFile(join(root, 'deploy-demo.json'), 'utf8')), declaration);
 const scoped = await rer();
 assert.equal(scoped.code, 0, scoped.stdout + scoped.stderr);
 const scopedConfig = JSON.parse(await readFile(join(root, '.rer/demo-host/wrangler.json'), 'utf8'));
 assert.equal(scopedConfig.vars.DEMO_RUN_URL, 'https://run-fixture.test/run');
 // The supported custom site declaration keeps both exits canonical even when
 // a stale standard filename points somewhere else on a scoped demo host.
 await writeFile(join(root, 'deploy-site.json'), JSON.stringify({ version: 1, domain: 'wrong-fixture.test' }));
 const withoutRunUrl = { ...declaration };
 delete withoutRunUrl.runUrl;
 await configure(withoutRunUrl);
 const canonical = await rer();
 assert.equal(canonical.code, 0, canonical.stdout + canonical.stderr);
 const canonicalConfig = JSON.parse(await readFile(join(root, '.rer/demo-host/wrangler.json'), 'utf8'));
 assert.equal((await localExit()).url, canonicalConfig.vars.DEMO_RUN_URL);
 assert.equal(new URL(canonicalConfig.vars.DEMO_RUN_URL).hostname, 'run-fixture.test');
 // Supported OPERATIONS spellings use the same path resolver through Vite's
 // serve/build hooks and the public hosted packaging command.
 const operations = JSON.parse(await readFile(join(root, 'OPERATIONS.json'), 'utf8'));
 const adapterSource = await readFile(join(root, 'adapter.mjs'), 'utf8');
 for (const [adapter, site] of [['./adapter.mjs', 'config/site.json'], ['config/adapter.mjs', './config/site.json'], ['./config/./nested-adapter.mjs', 'config/./site.json']]) {
  await writeFile(join(root, adapter), adapterSource.replace("declaration:'config/site.json'", `declaration:${JSON.stringify(site)}`));
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ ...operations, seedContract: { ...operations.seedContract, adapter } }));
  const packaged = await rer();
  assert.equal(packaged.code, 0, packaged.stdout + packaged.stderr);
  const hosted = JSON.parse(await readFile(join(root, '.rer/demo-host/wrangler.json'), 'utf8')).vars.DEMO_RUN_URL;
  for (const command of ['serve', 'build']) assert.equal((await localExit(command)).url, hosted);
  assert.equal(hosted, canonicalConfig.vars.DEMO_RUN_URL);
 }
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ ...operations, seedContract: { ...operations.seedContract, adapter: '../adapter.mjs' } }));
 for (const command of ['serve', 'build']) await assert.rejects(() => localExit(command), error => error.exitCode === 2);
 const escaped = await rer();
 assert.equal(escaped.code, 2, escaped.stdout + escaped.stderr);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(operations));
 await configure({ ...declaration, runUrl: 'https://override-fixture.test/run' });
 assert.equal((await localExit()).url, 'https://override-fixture.test/run');
 await configure();

 const workerConfig = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
 await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ ...workerConfig, durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'MissingCounter' }] } }));
 const missingClass = await rer();
 assert.equal(missingClass.code, 1, missingClass.stdout + missingClass.stderr);
 assert.match(missingClass.stdout + missingClass.stderr, /cannot bind COUNTER:.*MissingCounter/);
 await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify(workerConfig));

 for (const runUrl of ['http://run-fixture.test/run', 'https://run-fixture.test/', 'javascript:alert(1)', 'data:text/html,unsafe', '//outside.test/run', {}, 42, null, true, ['https://run-fixture.test/run'], 'https://user:password@run-fixture.test/run', 'https://run-\nfixture.test/run']) {
  await configure({ ...declaration, runUrl });
  await assert.rejects(() => localExit(), /invalid-demo-run-url/);
  const refused = await rer();
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /invalid-demo-run-url/);
 }
 for (const value of [undefined, '', 'Page.' + primary, 'outside.example.test', primary + '.outside.test', 'other' + primary,
  'https://' + page, page + ':443', 'a'.repeat(64) + '.' + primary, 'bad..' + primary]) {
  await configure({ ...declaration, settings: { ...declaration.settings, PAGE_HOST: value } });
  const refused = await rer();
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /invalid-demo-host-setting/);
 }
 for (const hostVariables of ['PAGE_HOST', [42], ['page_host']]) {
  await configure(declaration, { ...app, container: { ...app.container, hostVariables } });
  const refused = await rer();
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /invalid-demo-host-variables/);
 }
});
