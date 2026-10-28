import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { demoPlan } from '../../modules/demo-host/plan.mjs';

// A real Vite/Workers project, matching the public demo packaging fixture.
export async function demoProject(t) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-demo-deploy-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 const app = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', originVar: 'APP_ORIGIN', platforms: ['workers'] };
 const declaration = { version: 1, domain: 'test.run-fixture.test', name: 'Fixture' };
 for (const [path, value] of Object.entries({
  'deploy.json': app, 'deploy-demo.json': declaration,
  'package.json': { type: 'module', engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' },
  'wrangler.jsonc': { name: 'demo-deploy-fixture', main: 'src/server.ts', compatibility_date: app.compatibilityDate, assets: { directory: 'public', binding: 'ASSETS' } },
  'OPERATIONS.json': { version: 2, project: app.project, runtime: { requirements: [] }, requiredEnvironment: [],
   seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: {
    argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy the fixture demo to the fake Cloudflare account.' } } },
 })) await writeFile(join(root, path), JSON.stringify(value));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, '.gitignore'), '.rer/\n.seed/\n.wrangler/\nnode_modules/\ndist/\n');
 await mkdir(join(root, 'src')); await mkdir(join(root, 'public'));
 await symlink(resolve(import.meta.dirname, '../../default-seed/node_modules'), join(root, 'node_modules'));
 await writeFile(join(root, 'src/client.js'), 'console.log(42)');
 await writeFile(join(root, 'src/server.ts'), 'export default {fetch() { return Response.json({ok:true}); }};');
 await writeFile(join(root, 'vite.config.mjs'), `
  import {cloudflare} from '@cloudflare/vite-plugin';
  export default {logLevel:'silent',plugins:[cloudflare({persistState:{path:process.env.RER_STATE_DIR ?? '.wrangler/state'},viteEnvironment:{name:'ssr'}})],
   environments:{ssr:{build:{outDir:'dist/server'}},client:{build:{outDir:'dist/client',rolldownOptions:{input:'src/client.js'}}}},
   builder:{buildApp:async builder=>{await builder.build(builder.environments.client);await builder.build(builder.environments.ssr);}}};
 `);
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('../deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:[],hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 execFileSync('git', ['init', '-q'], { cwd: root });
 execFileSync('git', ['add', '.'], { cwd: root });
 execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: root });
 return { root, plan: demoPlan({ project: app.project, environment: 'demo-test', compatibilityDate: app.compatibilityDate, originVar: app.originVar, declaration }) };
}
