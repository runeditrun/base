import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { demoPlan } from '../modules/demo-host/plan.mjs';

// deploy-demo.json's instanceType: the dry run refuses a type Cloudflare Containers does not offer before
// building anything, and the plan it writes runs each visitor's container on the chosen type (basic unless set).
test('rer deploy --demo --dry-run plans the declared container instance type and refuses an unknown one', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-demo-plan-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const app = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', originVar: 'APP_ORIGIN', platforms: ['workers', 'container'] };
 const declaration = { version: 1, domain: 'test.run-fixture.test', name: 'Fixture' };
 await writeFile(join(root, 'deploy.json'), JSON.stringify(app));
 await writeFile(join(root, 'deploy-demo.json'), JSON.stringify({ ...declaration, instanceType: 'standard-9' }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.gitignore'), '.rer/\n.seed/\n');
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:{},hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Plan the fixture demo.' } } }));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const rer = spawnSync(process.execPath, [new URL('../bin/rer.mjs', import.meta.url).pathname, 'deploy', '--demo', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 20000 });
 const printed = rer.stdout + rer.stderr;
 assert.equal(rer.status, 2, printed);
 assert.match(printed, /invalid-demo-instance-type/);
 assert.match(printed, /lite, basic, standard-1, standard-2, standard-3, standard-4/);

 const plan = instanceType => demoPlan({ project: app.project, environment: 'production', compatibilityDate: app.compatibilityDate, originVar: app.originVar, declaration: { ...declaration, ...(instanceType && { instanceType }) } });
 assert.equal(plan().wrangler.containers[0].instance_type, 'basic');
 assert.equal(plan('standard-1').instanceType, 'standard-1');
 assert.equal(plan('standard-1').wrangler.containers[0].instance_type, 'standard-1');
 for (const refused of ['standard', 'dev', 'Standard-1', { vcpu: 1 }]) assert.throws(() => plan(refused), /invalid-demo-instance-type/);
});
