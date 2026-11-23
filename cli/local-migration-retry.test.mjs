import '../modules/container/adapters/d1-workerd-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort, run } from '../global/tests/harness.mjs';
import { buildPackage } from '../scripts/rer-package.mjs';
import { isolatedQueue } from './fixtures/queue.mjs';

const base = resolve(import.meta.dirname, '..');
const require = createRequire(join(base, 'default-seed/package.json'));
const wrangler = resolve(require.resolve('wrangler/package.json'), '../bin/wrangler.js');
const { getPlatformProxy } = require('wrangler');

test('rer dev recovers a local migration with a lost Wrangler response and surfaces SQL errors without retrying', { timeout: 120_000 }, async t => {
 const home = await mkdtemp(join(tmpdir(), 'rer-migration-retry-'));
 t.after(() => rm(home, { recursive: true, force: true }));
 const packed = await buildPackage(base, join(home, 'build'));
 const extracted = await run('tar', ['-xzf', packed, '-C', home]);
 assert.equal(extracted.code, 0, extracted.stderr);
 const pkg = join(home, 'package'), entry = join(pkg, 'global/rer.mjs');
 const source = path => JSON.stringify(pathToFileURL(join(pkg, path)).href);
 const env = await isolatedQueue(t, { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, HOME: home, CI: 'true', RER_NO_UPDATE_CHECK: '1', WRANGLER_SEND_METRICS: 'false' });
 const mig = ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', '.wrangler/state', '--config', 'wrangler.jsonc'];
 async function launch(name, sql) {
  const root = join(home, name);
  await mkdir(join(root, 'migrations'), { recursive: true });
  const port = await freePort();
  const files = {
   'package.json': JSON.stringify({ name: 'migration-retry', type: 'module', packageManager: 'pnpm@10.12.4', engines: { node: process.versions.node } }),
   'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
   'OPERATIONS.json': JSON.stringify({ version: 2, project: 'migration-retry', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { dev: { argv: ['node', 'app.mjs'], inputs: [], effects: 'Serve the migrated workspace.' } } }),
   'rer-setup.json': JSON.stringify({ schema: 1, title: 'Local workspace', groups: [], steps: [{ type: 'extension', id: 'native-owner' }], fields: [{ name: 'OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true }] }),
   'adapter.mjs': `import { localInstaller } from ${source('onboarding/adapter.mjs')};
import { commandAdapter as declare } from ${source('cli/adapter.mjs')};
export const commandAdapter = declare(localInstaller({
 secrets: { originKey: 'AUTH_ORIGIN' }, migrate: [process.execPath, ['wrangler.js', ...${JSON.stringify(mig)}]],
 start: ({ runtimePort }) => [process.execPath, ['app.mjs', String(runtimePort)]]
}), { setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'OWNER_EMAIL' } }, scheduled: false });
`,
   'app.mjs': `import { createServer } from 'node:http';
createServer((request, response) => response.end(request.url === '/health' ? '{"status":"ok"}' : 'Workspace is ready')).listen(Number(process.argv[2]), '127.0.0.1');
`,
   'wrangler.js': `import { appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const first = !existsSync('attempts');
appendFileSync('attempts', 'apply\\n');
const lost = ${name === 'lost'} && first;
const exhausted = ${name === 'exhausted'};
const result = exhausted ? undefined : spawnSync(process.execPath, [${JSON.stringify(wrangler)}, ...process.argv.slice(2)], { stdio: lost ? 'ignore' : 'inherit' });
if (exhausted || result.status === 0 && lost) {
 console.error('✘ [ERROR] internal error; reference = locald1lostresponse');
 process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
`,
   'wrangler.jsonc': JSON.stringify({ name: 'migration-retry', compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'workspace', database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: 'migrations' }] }),
   'migrations/0001_workspace.sql': sql,
  };
  await Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(root, path), content)));
  const cli = (...args) => run(process.execPath, [entry, ...args], { cwd: root, env });
  const result = await cli('dev', '--port', String(port), '--detach');
  return { root, cli, result, url: `http://127.0.0.1:${port}`, attempts: () => readFile(join(root, 'attempts'), 'utf8').then(text => text.trim().split('\n').length) };
 }
 const sql = "CREATE TABLE workspace (name TEXT); INSERT INTO workspace VALUES ('Support operations');";
 const recovered = await launch('lost', sql);
 try {
  assert.equal(recovered.result.code, 0, recovered.result.stderr);
  assert.equal(recovered.result.stderr.match(/retrying local database migrations/gi)?.length, 1);
  assert.equal(await recovered.attempts(), 3, 'setup applies twice and the subsequent dev ledger check runs once');
  assert.equal(await fetch(recovered.url).then(response => response.text()), 'Workspace is ready');
  const proxy = await getPlatformProxy({ configPath: join(recovered.root, 'wrangler.jsonc'), persist: { path: join(recovered.root, '.wrangler/state/v3') }, remoteBindings: false });
  try {
   assert.deepEqual((await proxy.env.DB.prepare('SELECT name FROM workspace').all()).results, [{ name: 'Support operations' }]);
   assert.deepEqual((await proxy.env.DB.prepare('SELECT name FROM d1_migrations').all()).results, [{ name: '0001_workspace.sql' }]);
  } finally { await proxy.dispose(); }
 } finally { await recovered.cli('dev', '--stop'); }

 const invalid = await launch('invalid', sql + ' SELECT * FROM missing_table;');
 assert.equal(invalid.result.code, 1, invalid.result.stderr);
 assert.match(invalid.result.stderr, /no such table: missing_table/i);
 assert.doesNotMatch(invalid.result.stderr, /retrying local database migrations/i);
 assert.equal(await invalid.attempts(), 1);

 const exhausted = await launch('exhausted', sql);
 assert.equal(exhausted.result.code, 1, exhausted.result.stderr);
 assert.match(exhausted.result.stderr, /internal error; reference = /);
 assert.match(exhausted.result.stderr, /run [^\n]+rer dev[^\n]+again/i);
 assert.equal(exhausted.result.stderr.match(/retrying local database migrations/gi)?.length, 1);
 assert.equal(await exhausted.attempts(), 2);
});
