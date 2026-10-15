import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function finalizingDeploy(t) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer finalization ')));
 t.after(() => rm(root, { recursive: true, force: true }));
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default {}');
 await writeFile(join(root, 'dist/client/index.html'), 'Application');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', vars: { MAIL_PROVIDER: 'resend', MAIL_FROM: 'owner@example.test', MAIL_API_KEY: 'test-only-mail-key' }, secrets: [{ binding: 'SETUP_TOKEN', environment: 'SETUP_TOKEN' }] }));
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\nowner credentials.env\n');
 await writeFile(join(root, 'owner credentials.env'), `CLOUDFLARE_ACCOUNT_ID=${'a'.repeat(32)}\nCLOUDFLARE_API_TOKEN=test-only-provider-token\nSETUP_TOKEN=test-only-setup-token\n`, { mode: 0o600 });
 await writeFile(join(root, 'adapter.mjs'), `import { ownerDeploy } from ${JSON.stringify(new URL('../deploy.mjs', import.meta.url).href)};
import { hookReturned } from ${JSON.stringify(new URL('./finalizing-deploy-network.mjs', import.meta.url).href)};
const lifecycle = { run: async () => {}, settings: [], hooks: { owner: {} } };
const deploy = ownerDeploy('deploy.json', lifecycle);
export const commandAdapter = { ...lifecycle, deployDeclaration: 'deploy.json', deploy: async context => {
 const result = await deploy(context); hookReturned(); return result;
} };`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy to the test provider.' } } }));
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const again = "rer deploy --environment review --env-file 'owner credentials.env' --cwd .";
 const run = async mode => {
  try { return { code: 0, ...await promisify(execFile)(process.execPath, [new URL('../../bin/rer.mjs', import.meta.url).pathname, 'deploy', '--environment', 'review', '--env-file', 'owner credentials.env', '--cwd', root, '--json'], {
   cwd: root, env: { ...process.env, CI: 'true', RER_TEST_FINAL_HEALTH: mode, NODE_OPTIONS: `--import=${new URL('./finalizing-deploy-network.mjs', import.meta.url).href}` }, timeout: 30000,
  }) }; } catch (error) { if (typeof error.code !== 'number') throw error; return error; }
 };
 return { root, run, again };
}
