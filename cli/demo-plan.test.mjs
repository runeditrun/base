import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { isolatedQueue } from './fixtures/queue.mjs';

const execute = promisify(execFile);

// Exercise the public CLI and real Vite/Cloudflare image packaging. No build
// stub supplies the image or generated deployment configuration.
test('rer deploy --demo --dry-run packages declared public hosts and refuses unsafe declarations', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-demo-plan-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const primary = 'demo.test.run-fixture.test', page = `page.${primary}`, status = `status.${primary}`;
 const app = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', originVar: 'APP_ORIGIN',
  platforms: ['workers', 'container'], container: { engine: 'workerd', hostVariables: ['STATUS_HOST', 'APP_HOST', 'PAGE_HOST', 'PAGE_ALIAS'] } };
 const declaration = { version: 1, domain: 'test.run-fixture.test', name: 'Fixture', instanceType: 'standard-1',
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
 await symlink(resolve(import.meta.dirname, '../default-seed/node_modules'), join(root, 'node_modules'));
 await writeFile(join(root, 'src/server.ts'), "export default {fetch(request) { return Response.json({ok:true,origin:new URL(request.url).origin}); }};");
 await writeFile(join(root, 'vite.config.mjs'), `
  import {cloudflare} from '@cloudflare/vite-plugin';
  export default {logLevel:'silent',plugins:[cloudflare({viteEnvironment:{name:'ssr'}})],
   environments:{ssr:{build:{outDir:'dist/server'}}},
   builder:{buildApp:async builder=>{await builder.build(builder.environments.ssr);}}};
 `);
 await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'demo-plan-fixture', main: 'src/server.ts', compatibility_date: app.compatibilityDate }));
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:[],hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('owner-deployment.json',lifecycle)};`);
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
 const built = await rer();
 assert.equal(built.code, 0, built.stdout + built.stderr);
 const config = JSON.parse(await readFile(join(root, '.rer/demo-host/wrangler.json'), 'utf8'));
 const hostnames = [primary, page, status];
 assert.deepEqual(config.routes, hostnames.map(pattern => ({ pattern, custom_domain: true })));
 assert.deepEqual(JSON.parse(config.vars.DEMO_SECONDARY_ORIGINS), [`https://${page}`, `https://${status}`]);
 assert.deepEqual(JSON.parse(config.vars.DEMO_SETTINGS), declaration.settings);
 assert.equal(config.containers[0].instance_type, declaration.instanceType);
 const manifest = JSON.parse(await readFile(join(root, '.rer/demo-host/image/app/container.json'), 'utf8'));
 assert.equal(manifest.engine, 'workerd');
 assert.ok((await readFile(join(root, '.rer/demo-host/image/app', manifest.entry), 'utf8')).trim(), 'the real build emitted the packaged Worker entry');
 const summary = built.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.event === 'demo');
 assert.deepEqual(summary.hostnames, hostnames);
 assert.deepEqual(summary.routes, config.routes);

 for (const instanceType of ['standard-9', 'standard', 'dev', 'Standard-1', { vcpu: 1 }]) {
  await configure({ ...declaration, instanceType });
  const refused = await rer();
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /invalid-demo-instance-type/);
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
