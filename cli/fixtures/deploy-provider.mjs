import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from '../main.mjs';
import { ownerProvider } from '../../modules/deploy-kit/tests/owner-provider.mjs';

export async function deployProviderFixture(t, declaration = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-remove-')));
 const provider = ownerProvider({ creationDates: true });
 const saved = { ...process.env };
 t.after(async () => { provider.close(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
 Object.assign(process.env, { CI: 'true', CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token });
 t.mock.method(globalThis, 'fetch', provider.fetch);
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default {fetch(){}}');
 await writeFile(join(root, 'dist/client/index.html'), 'app');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', r2: [{ binding: 'FILES' }], ...declaration }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({engines:{node:process.versions.node},packageManager:'pnpm@10.12.4'}));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\n.dev.vars\ndeploy.env\n');
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('../deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:{},hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({version:2,project:'tests/fixture',runtime:{requirements:[]},requiredEnvironment:[],seedContract:{version:1,profile:'first-party',adapter:'adapter.mjs'},commands:{deploy:{argv:['node','adapter.mjs'],inputs:['adapter.mjs','deploy.json'],effects:'Deploy or remove the fixture in the fake Cloudflare account.'}}}));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const run = (...flags) => main(['deploy', '--cwd', root, '--json', ...flags]);
 return {root, provider, run};
}

