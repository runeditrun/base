import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as cli } from './main.mjs';
import { checkout, account } from './fixtures/owner-deploy.mjs';

const execute = promisify(execFile);

test('the public deploy dry run reaches offline seed hooks and reports unchecked providers with or without a hook', async t => {
 for (const hook of ['managed', 'legacy', 'none', 'kit', 'missing-owner']) {
  const { root } = await checkout(t, { secrets: [{ binding: 'EMAIL_API_KEY', environment: 'EMAIL_API_KEY' }],
   d1:[{binding:'DB'},{binding:'REPORTS'}],r2:[{binding:'FILES'}],kv:[{binding:'CACHE'}],queues:[{binding:'JOBS'}] });
  await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {main as owner} from ${JSON.stringify(new URL('../modules/deploy-kit/owner-cli.mjs', import.meta.url).href)};
import {missing} from ${JSON.stringify(new URL('./errors.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:[],hooks:{}};
const offline = async ({root,options}) => {
 if (!options.dryRun) throw Error('This seed fixture only supports offline preflight');
 await writeFile(join(root,'offline-hook.json'),JSON.stringify({dryRun:options.dryRun}));
 ${hook === 'missing-owner' ? "throw missing('A real deploy needs a real OWNER_EMAIL.');" : ''}
 ${hook === 'kit' ? "return owner(['dry-run','--declaration','deploy.json','--environment','production'],process.env,{cwd:root});" : ''}
 return {dryRun:true,deployed:false};
};
offline.managesHostedOwner = ${hook === 'managed' || hook === 'missing-owner'};
export const commandAdapter = {...lifecycle,deploy:${hook === 'none' ? "ownerDeploy('deploy.json',lifecycle)" : 'offline'}};`);
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Preflight the seed deployment offline.' } } }));
  await writeFile(join(root, '.node-version'), process.versions.node + '\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
  const network = join(root, 'network.mjs'), requests = join(root, 'requests.txt');
  await writeFile(requests, '');
  await writeFile(network, `import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(requests)},'request\\n');throw Error('Offline preflight must not access a provider')};`);
  const env = { ...process.env, CI: 'true', HOME: root, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(network).href}`].filter(Boolean).join(' ') };
  for (const name of Object.keys(env)) if (/^(CLOUDFLARE_|CF_)/.test(name) || name === 'EMAIL_API_KEY') delete env[name];
  const { stdout: output } = await execute(process.execPath, [fileURLToPath(new URL('../bin/rer.mjs', import.meta.url)), 'deploy', '--dry-run', '--cwd', root, '--json'], { env });
  const receipt = output.trim().split('\n').map(JSON.parse).at(-1);
  if (hook !== 'none') assert.deepEqual(JSON.parse(await readFile(join(root, 'offline-hook.json'), 'utf8')), { dryRun: true }, `${hook} seed hook is reached`);
  else await assert.rejects(access(join(root, 'offline-hook.json')), { code: 'ENOENT' });
  assert.deepEqual([receipt.ok, receipt.dryRun, receipt.deployed, receipt.providerChecked], [true, true, false, false], `${hook} receipt`);
  // A hook that returned no kit state validated its own plan: rer does not plan against the declaration it names.
  if (hook === 'legacy') assert.equal(receipt.plan, undefined, 'a stateless hook skips rer\'s own plan');
  else assert.equal(receipt.plan.worker, 'fixture-production', `${hook} keeps the local plan`);
  if (hook === 'missing-owner') assert.match(receipt.neededForRealDeploy.join('\n'), /real OWNER_EMAIL/);
  assert.match(receipt.neededForRealDeploy.join('\n'), /\bEMAIL_API_KEY\b/);
  assert.equal(await readFile(requests, 'utf8'), '', `${hook} preflight makes no provider request`);
  if(hook === 'none') {
   const human=await execute(process.execPath,[fileURLToPath(new URL('../bin/rer.mjs',import.meta.url)),'deploy','--dry-run','--cwd',root],{env});
   const text=human.stdout+human.stderr;
   for(const database of receipt.plan.d1)assert.ok(text.includes(`D1 database: ${database.name}`));
   for(const [kind,label] of [['r2','R2 storage'],['kv','KV storage'],['queues','Queue']])assert.ok(text.includes(`${label}: ${receipt.plan[kind][0].name}`));
   assert.match(text,/Workers R2 Storage: Edit/);
   assert.match(text,/Workers KV Storage: Edit/);
   assert.match(text,/Queues: Edit/);
   assert.equal(await readFile(requests,'utf8'),'','the readable resource plan also stays offline');
  }
  await assert.rejects(access(join(root, '.rer/deploy/production.json')), { code: 'ENOENT' });
 }
});

test('deploy dry run prints a local plan without credentials or provider access while deploy keeps its refusals', async t => {
 const secrets = [
  { binding: 'GOOGLE_MAIL_CLIENT_ID', environment: 'FIXTURE_GOOGLE_ID' },
  { binding: 'GOOGLE_MAIL_CLIENT_SECRET', environment: 'FIXTURE_GOOGLE_SECRET' },
  { binding: 'OPTIONAL_MAIL', environment: 'FIXTURE_OPTIONAL_MAIL', optional: true },
 ];
 const { root, git } = await checkout(t, { secrets, project: 'synthetic-base-1' });
 await writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:{},hooks:{}};
export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy to the fake provider.' } } }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 git('add', '.'); git('commit', '-qm', 'deploy door');
 const { provider } = account(t);
 const saved = Object.fromEntries(['CI', 'HOME', ...Object.keys(process.env).filter(name => /^(CLOUDFLARE_|CF_)/.test(name)), ...secrets.map(item => item.environment)].map(name => [name, process.env[name]]));
 t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
 process.env.CI = 'true';
 process.env.HOME = root;
 for (const { environment } of secrets) delete process.env[environment];
 const invoke = async (json, ...flags) => {
  const output = [], diagnostics = [];
  const capture = t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', chunk => { diagnostics.push(String(chunk)); return true; });
  const code = await cli(['deploy', ...flags, '--cwd', root, ...(json ? ['--json'] : [])]).finally(() => { capture.mock.restore(); stderr.mock.restore(); });
  const events = json ? output.join('').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { code, text: output.join('') + diagnostics.join(''), events, error: events.find(event => event.event === 'error'), stderr: diagnostics.join('') };
 };
 const rer = (...flags) => invoke(true, ...flags);
 const readOnly = async (...flags) => {
  const before = provider.state.calls.length;
  const result = await rer('--dry-run', ...flags);
  assert.equal(provider.state.calls.length, before, 'no provider call reaches the fake target');
  return result;
 };
 for (const name of Object.keys(process.env)) if (/^(CLOUDFLARE_|CF_)/.test(name)) delete process.env[name];
 const dry = await readOnly();
 assert.equal(dry.code, 0, dry.text);
 const plan = dry.events.at(-1).plan;
 assert.equal(plan.worker, 'synthetic-base-1-production');
 assert.equal(plan.d1[0].binding, 'DB');
 assert.deepEqual(plan.d1[0].migrations, ['0001_owner.sql']);
 assert.deepEqual(plan.secrets.map(item => item.binding), secrets.map(item => item.binding));
 assert.match(dry.text, /no credentials were needed/);
 assert.match(dry.text, /nothing was changed remotely/);
 const human = await invoke(false, '--dry-run');
 assert.equal(human.code, 0, human.text);
 assert.match(human.text, /Would deploy:/);
 assert.ok(human.text.includes(`Worker: ${plan.worker}`));
 assert.ok(human.text.includes(`D1 database: ${plan.d1[0].name}`));
 assert.ok(human.text.includes(`${plan.d1[0].migrations.length} declared migration`));
 assert.match(human.text,/Pending migrations: unknown/);
 assert.match(human.text,/Workers Scripts: Edit, D1: Edit/);
 assert.doesNotMatch(human.text,/"worker"|0001_owner\.sql|GOOGLE_MAIL_CLIENT_SECRET/);
 const logPath=/Redacted capture log: (.+)/.exec(human.text)?.[1];
 assert.ok(logPath,'the readable plan links to its complete capture');
 const log=await readFile(join(root,logPath),'utf8');
 const capturedPlan=JSON.parse(log.split('\n').find(line=>line.startsWith('Deploy plan: ')).slice('Deploy plan: '.length));
 assert.deepEqual(capturedPlan,plan,'the full structured plan survives in the log and --json');
 t.diagnostic(`Dry run: exit ${human.code}; ${human.text}`);
 await assert.rejects(access(join(root, '.rer/deploy/production.json')), { code: 'ENOENT' });
 const real = await rer();
 assert.equal(real.code, 3, real.text);
 assert.match(real.error.message, /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to deploy to your Cloudflare account. Nothing was deployed./);
 t.diagnostic(`Real deploy: exit ${real.code}; ${real.error.message}`);
 assert.equal(provider.state.calls.length, 0);
 Object.assign(process.env, {CLOUDFLARE_ACCOUNT_ID:provider.accountId, CLOUDFLARE_API_TOKEN:provider.token});
 const missing = await rer();
 assert.equal(missing.code, 1);
 for (const {binding, environment} of secrets.filter(item => !item.optional)) {
  assert.ok(missing.error.message.includes(binding), missing.error.message);
  assert.ok(missing.error.message.includes(environment), missing.error.message);
 }
 assert.equal(provider.state.writes.length, 0);
 Object.assign(process.env, { FIXTURE_GOOGLE_ID: 'synthetic-base-2', FIXTURE_GOOGLE_SECRET: 'synthetic-base-3' });
 assert.equal((await readOnly()).code, 0);
 assert.equal(provider.state.writes.length, 0, 'supplied bindings are validated without uploading them');
 assert.equal((await rer()).code, 0, 'establish the existing target through the same fake deploy door');
 delete process.env.FIXTURE_GOOGLE_ID; delete process.env.FIXTURE_GOOGLE_SECRET;
 const writes = provider.state.writes.length, statePath = join(root, '.rer/deploy/production.json'), state = await readFile(statePath);
 const held = await readOnly();
 assert.equal(held.code, 0);
 assert.ok(held.text.includes('FIXTURE_GOOGLE_ID'), 'local plan cannot confirm held secrets');
 assert.equal(provider.state.writes.length, writes);
 assert.deepEqual(await readFile(statePath), state, 'dry run leaves deployment state untouched');
 provider.state.secrets.splice(0, provider.state.secrets.length);
 const absent = await readOnly(), refused = await rer();
 assert.equal(absent.code, 0);
 assert.equal(refused.code, 1);
 for (const { binding } of secrets.filter(item => !item.optional)) assert.ok(refused.error.message.includes(binding), refused.error.message);
 assert.equal(provider.state.writes.length, writes);
 provider.fail('GET', /\/secrets$/, { status: 403 });
 const denied = await readOnly();
 assert.equal(denied.code, 0, 'local dry run does not require secret-list permission');
 const realDenied = await rer();
 assert.equal(realDenied.code, 1);
 assert.match(realDenied.error.message, /secret.*list|list.*secret/i);
 assert.match(realDenied.error.message, /Workers Scripts|token-scope-missing-workers/);
 Object.assign(process.env, { FIXTURE_GOOGLE_ID: 'synthetic-base-2', FIXTURE_GOOGLE_SECRET: 'synthetic-base-3' });
 assert.equal((await rer()).code, 0);
 assert.equal((await rer('--unset-secret', 'GOOGLE_MAIL_CLIENT_ID')).code, 0);
 delete process.env.FIXTURE_GOOGLE_ID; delete process.env.FIXTURE_GOOGLE_SECRET;
 const retiredState = await readFile(statePath), retiredWrites = provider.state.writes.length;
 assert.equal((await readOnly()).code, 0, 'the same recorded retired binding stays out of dry-run and deploy plans');
 assert.deepEqual(await readFile(statePath), retiredState);
 assert.equal(provider.state.writes.length, retiredWrites);
 delete process.env.CLOUDFLARE_API_TOKEN;
 const unauthenticated = await readOnly();
 assert.equal(unauthenticated.code, 0);
 assert.equal(provider.state.writes.length, retiredWrites);
});

test('a dry run whose seed step stops on missing inputs prints its list once, then one failure and the same dry run to repeat', async t => {
 const { root, git } = await checkout(t, { secrets: [] });
 await writeFile(join(root, 'adapter.mjs'), `const lifecycle = {run:async()=>{},settings:{},hooks:{}};
const deploy = async ({root,store,signal,operationToken}) => {
 await store.run('Validating the fixture deployment locally',process.execPath,['preflight.mjs'],{cwd:root,signal,env:{...process.env,RER_LOCAL_OPERATION:operationToken}});
 return {dryRun:true,deployed:false};
};
export const commandAdapter = {...lifecycle,deploy};`);
 // What a seed's input check under \`pnpm run\` prints: pnpm's banner, the seed's list, pnpm's failure line.
 await writeFile(join(root, 'preflight.mjs'), `process.stderr.write(['','> @ deploy:cloudflare /fixture','> node preflight.mjs --dry-run','','Set these inputs in your private input file:','  FIXTURE_APP_HOST: the address you sign in at',' ELIFECYCLE  Command failed with exit code 1.',''].join('\\n'));process.exitCode=1;`);
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Preflight the seed deployment offline.' } } }));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 await writeFile(join(root, 'empty.env'), '', { mode: 0o600 });
 git('add', '.'); git('commit', '-qm', 'deploy door');
 const env = { ...process.env, CI: 'true', HOME: root };
 for (const name of Object.keys(env)) if (/^(CLOUDFLARE_|CF_)/.test(name)) delete env[name];
 const failed = await execute(process.execPath, [fileURLToPath(new URL('../bin/rer.mjs', import.meta.url)), 'deploy', '--dry-run', '--environment', 'production', '--env-file', 'empty.env', '--cwd', root], { env, cwd: root }).then(() => assert.fail('the dry run stopped, so it fails'), error => error);
 const text = failed.stdout + failed.stderr;
 assert.equal(failed.code, 1, text);
 assert.equal(text.match(/FIXTURE_APP_HOST/g)?.length, 1, `the seed's list prints once:\n${text}`);
 assert.doesNotMatch(text, /ELIFECYCLE|^> /m, 'pnpm\'s own wrapper lines are not repeated');
 assert.doesNotMatch(text, /Last output|install\.log/, 'no second copy of the output, no log path to chase');
 assert.match(text, /nothing was deployed\. Validating the fixture deployment locally: exit 1\./);
 assert.match(text, /run rer deploy --environment production --env-file empty\.env --cwd \. --dry-run again/, 'the next step repeats the dry run, never a real deploy');
 const real = await execute(process.execPath, [fileURLToPath(new URL('../bin/rer.mjs', import.meta.url)), 'deploy', '--environment', 'production', '--env-file', 'empty.env', '--cwd', root], { env, cwd: root }).then(() => assert.fail('the same seed check stops a real deploy'), error => error);
 assert.equal(real.code, 1, real.stdout + real.stderr);
 assert.match(real.stdout + real.stderr, /run rer deploy --environment production --env-file empty\.env --cwd \. again using the same environment credentials/);
});
