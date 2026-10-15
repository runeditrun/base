import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';

const exec = promisify(execFile), entry = new URL('../bin/rer.mjs', import.meta.url).pathname;

test('missing deployment commands name the requested environment and offer the checkout records through the CLI', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-deployment-record-')));
 t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, '.rer/deploy'), { recursive: true });
 await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, '.node-version'), process.versions.node);
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', secrets: [{ binding: 'SESSION_SECRET', environment: 'SESSION_SECRET' }] }));
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
 const lifecycle = {run:async()=>{},settings:[],hooks:{}};
 export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Manage the test deployment.' } } }));
 // The CLI and bounded child are real processes. Only the provider edge is fake.
 const preload = join(root, 'network.mjs');
 await writeFile(preload, `import {ownerProvider} from ${JSON.stringify(new URL('../modules/deploy-kit/tests/owner-provider.mjs', import.meta.url).href)};
 const provider = ownerProvider();
 globalThis.fetch = (input, init = {}) => { if ((init.method ?? 'GET') !== 'GET') throw Error('Unexpected provider mutation'); return provider.fetch(input, init); };
 process.on('exit', () => provider.close());`);
 const provider = ownerProvider();
 const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${preload}`, CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token, SESSION_SECRET: 'fixture-session-value' };
 provider.close();
 const record = environment => JSON.stringify({ version: 1, kind: 'rer-deploy-owner-state', environment, project: 'tests/fixture', owned: { worker: null, d1: {}, r2: {}, kv: {}, queues: {} }, receipt: null });
 await writeFile(join(root, '.rer/deploy/sd-x.json'), record('sd-x'));
 // Hook records count once; site receipts, unfinished writes and unrelated JSON do not.
 await mkdir(join(root, '.rer/hook'), { recursive: true });
 await writeFile(join(root, '.rer/hook/review.json'), record('review'));
 await writeFile(join(root, '.rer/deploy/review.hook.json'), JSON.stringify({ state: '.rer/hook/review.json' }));
 await writeFile(join(root, '.rer/deploy/sd-x.hook.json'), JSON.stringify({ state: '.rer/deploy/sd-x.json' }));
 await writeFile(join(root, '.rer/deploy/site-production.json'), JSON.stringify({ origin: 'https://example.test' }));
 await writeFile(join(root, '.rer/deploy/other.json'), '{}');
 await writeFile(join(root, '.rer/deploy/broken.json'), '{');
 await writeFile(join(root, '.rer/deploy/unfinished.json.tmp'), record('unfinished'));
 const run = async (args, json = true) => {
  const result = await exec(process.execPath, [entry, ...args, '--cwd', root, ...(json ? ['--json'] : [])], { cwd: root, env, timeout: 30000 }).catch(error => error);
  assert.ok(result.code > 0, result.stdout + result.stderr);
  return json ? JSON.parse(result.stdout.trim().split('\n').find(line => JSON.parse(line).event === 'error')) : result.stderr;
 };
 for (const args of [['deploy', '--remove', '--yes'], ['signin'], ['deploy', '--set-secret', 'SESSION_SECRET'], ['deploy', '--unset-secret', 'SESSION_SECRET']]) {
  const error = await run(args);
  if (args[1] === '--remove') t.diagnostic(error.message);
  assert.equal(error.environment, 'production', error.message);
  assert.deepEqual(error.availableDeployments.map(item => item.environment), ['review', 'sd-x']);
  assert.ok(error.message.includes(error.environment));
  for (const item of error.availableDeployments) {
   const flags = args.slice(1).join(' ');
   assert.equal(item.command, `rer ${args[0]} --environment ${item.environment} --cwd ${root}${flags ? ` ${flags}` : ''}`);
   assert.ok(error.message.includes(item.command));
  }
  const human = await run(args, false);
  assert.ok(human.includes(error.message), human);
 }
 const explicit = await run(['signin', '--environment', 'missing']);
 assert.equal(explicit.environment, 'missing');
 await writeFile(join(root, 'hosted settings.env'), '', { mode: 0o600 });
 const contextual = await run(['deploy', '--remove', '--yes', '--environment', 'missing', '--env-file', 'hosted settings.env']);
 for (const item of contextual.availableDeployments) assert.ok(item.command.includes("--env-file 'hosted settings.env'"));
 await rm(join(root, '.rer/deploy'), { recursive: true });
 const empty = await run(['deploy', '--remove', '--yes']);
 assert.deepEqual(empty.availableDeployments, []);
 assert.match(empty.message, /no deployment environments/i);
 assert.match(empty.message, /checkout that deployed it/);
 t.diagnostic(empty.message);
});
