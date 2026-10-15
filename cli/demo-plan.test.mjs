import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { demoPlan } from '../modules/demo-host/plan.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

// deploy-demo.json's instanceType: the dry run refuses a type Cloudflare Containers does not offer before
// building anything, and the plan it writes runs each visitor's container on the chosen type (basic unless set).
test('rer deploy --demo --dry-run builds the declared deploy file and validates its container instance type', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-demo-plan-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const app = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', originVar: 'APP_ORIGIN', platforms: ['workers', 'container'] };
 const declaration = { version: 1, domain: 'test.run-fixture.test', name: 'Fixture' };
 await writeFile(join(root, 'owner-deployment.json'), JSON.stringify(app));
 await writeFile(join(root, 'deploy-demo.json'), JSON.stringify({ ...declaration, instanceType: 'standard-9' }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.gitignore'), '.rer/\n.seed/\n');
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:[],hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('owner-deployment.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'owner-deployment.json'], effects: 'Plan the fixture demo.' } } }));
 const env = await isolatedQueue(t);
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const run = () => spawnSync(process.execPath, [new URL('../bin/rer.mjs', import.meta.url).pathname, 'deploy', '--demo', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', env: { ...env, CI: 'true' }, timeout: 60000 });
 const rer = run();
 const printed = rer.stdout + rer.stderr;
 assert.equal(rer.status, 2, printed);
 assert.match(printed, /invalid-demo-instance-type/);
 assert.match(printed, /lite, basic, standard-1, standard-2, standard-3, standard-4/);

 const plan = instanceType => demoPlan({ project: app.project, environment: 'production', compatibilityDate: app.compatibilityDate, originVar: app.originVar, declaration: { ...declaration, ...(instanceType && { instanceType }) } });
 assert.equal(plan().wrangler.containers[0].instance_type, 'basic');
 assert.equal(plan('standard-1').instanceType, 'standard-1');
 assert.equal(plan('standard-1').wrangler.containers[0].instance_type, 'standard-1');
 for (const refused of ['standard', 'dev', 'Standard-1', { vcpu: 1 }]) assert.throws(() => plan(refused), /invalid-demo-instance-type/);

 // Build a real Worker through Vite and the CLI subprocess. There is no
 // deploy.json, so either handoff dropping the declaration breaks the build.
 await symlink(new URL('../default-seed/node_modules', import.meta.url).pathname, join(root, 'node_modules'));
 await mkdir(join(root, 'src'));
 await writeFile(join(root, 'src/worker.mjs'), "export default { fetch() { return new Response('demo'); } };\n");
 await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'demo-plan-fixture', main: 'src/worker.mjs', compatibility_date: '2026-09-01' }));
 await writeFile(join(root, 'vite.config.mjs'), `import {cloudflare} from '@cloudflare/vite-plugin';
export default {logLevel:'silent',plugins:[cloudflare({viteEnvironment:{name:'ssr'}})],environments:{ssr:{build:{outDir:'dist/server'}}},builder:{buildApp:async builder=>{await builder.build(builder.environments.ssr);}}};`);
 await writeFile(join(root, 'deploy-demo.json'), JSON.stringify(declaration));
 const built = run();
 assert.equal(built.status, 0, built.stdout + built.stderr);
 const manifest = JSON.parse(await readFile(join(root, '.rer/demo-host/image/app/container.json'), 'utf8'));
 assert.equal(manifest.engine, 'workerd');
 await access(join(root, '.rer/demo-host/image/app', manifest.entry));
 await access(join(root, '.rer/demo-host/image/Dockerfile'));
});
