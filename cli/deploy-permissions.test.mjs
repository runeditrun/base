import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkout } from './fixtures/owner-deploy.mjs';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/rer.mjs', import.meta.url));
const permissions = ['Workers Scripts: Edit', 'D1: Edit', 'Workers R2 Storage: Edit', 'Workers KV Storage: Edit', 'Queues: Edit'];
const cases = [
 { name: 'D1 only', resources: { d1: [{ binding: 'DB' }] }, expected: ['Workers Scripts: Edit', 'D1: Edit'] },
 { name: 'D1, R2 and Queues', resources: { d1: [{ binding: 'DB' }], r2: [{ binding: 'FILES' }], queues: [{ binding: 'JOBS' }] }, expected: ['Workers Scripts: Edit', 'D1: Edit', 'Workers R2 Storage: Edit', 'Queues: Edit'] },
 { name: 'Workers only', resources: { d1: [] }, expected: ['Workers Scripts: Edit'] },
 { name: 'KV only', resources: { d1: [], kv: [{ binding: 'CACHE' }] }, expected: ['Workers Scripts: Edit', 'Workers KV Storage: Edit'] },
];

function assertPermissions(text, expected) {
 for (const permission of permissions) assert.equal(text.includes(permission), expected.includes(permission), `${permission}: ${text}`);
}

function assertCredentialHelp(text, expected, grant) {
 assertPermissions(text, expected);
 if (grant) {
  assert.ok(text.includes('This run uses a company grant; no API token needs to be created'), text);
  assert.ok(!text.includes('https://dash.cloudflare.com/profile/api-tokens'), text);
  assert.doesNotMatch(text, /Create an account API token/);
 } else {
  assert.ok(text.includes('https://dash.cloudflare.com/profile/api-tokens'), text);
  assert.ok(text.includes('rer business run --grant <id> -- rer deploy ...'), text);
  assert.match(text, /CLOUDFLARE_ACCOUNT_ID and a scoped API token arrive automatically/);
 }
}

async function fixture(t, resources, grant) {
 const { root, git } = await checkout(t, { project: 'synthetic-base-1', secrets: [], ...resources });
 // A Worker without D1 has no SQL to package into a DB binding.
 if (!resources.d1.length) await rm(join(root, 'migrations/core/0001_owner.sql'));
 const requests = join(root, 'requests.txt'), network = join(root, 'network.mjs');
 await Promise.all([
  writeFile(join(root, 'adapter.mjs'), `import {ownerDeploy} from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
const lifecycle = {run:async()=>{},settings:[],hooks:{}};
export const commandAdapter = {...lifecycle,deploy:ownerDeploy('deploy.json',lifecycle)};
`),
  writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({
   version: 2, project: 'synthetic-base-1', runtime: { requirements: [] }, requiredEnvironment: [],
   seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' },
   commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Plan deployment and report missing credentials.' } },
  })),
  writeFile(join(root, '.node-version'), process.versions.node + '\n'),
  writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' })),
  writeFile(requests, ''),
  writeFile(network, `import {appendFileSync} from 'node:fs';
globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(requests)},'request\\n');throw Error('Permission guidance must not access a provider')};
`),
  writeFile(join(root, 'deploy.env'), 'CLOUDFLARE_ACCOUNT_ID=synthetic-base-2\nCLOUDFLARE_API_TOKEN=synthetic-base-3\n', { mode: 0o600 }),
 ]);
 git('add', '.'); git('commit', '-qm', 'Declare permission guidance fixture');
 const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CLOUDFLARE_|CF_|RER_BUSINESS_GRANT$)/.test(name)));
 Object.assign(env, { CI: 'true', HOME: root, NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${pathToFileURL(network).href}`].filter(Boolean).join(' ') });
 if (grant) env.RER_BUSINESS_GRANT = 'synthetic-company-grant';
 return {
  root,
  async run(args, expectedExit = 0) {
   const result = await execute(process.execPath, [entry, 'deploy', '--cwd', root, ...args], { env, signal: t.signal })
    .then(result => ({ ...result, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }));
   const text = result.stdout + result.stderr;
   assert.equal(result.code, expectedExit, text);
   assert.equal(await readFile(requests, 'utf8'), '', 'permission guidance makes no provider request');
   for (const credential of ['synthetic-base-2', 'synthetic-base-3']) assert.ok(!text.includes(credential), 'credential values stay private');
   return { ...result, text };
  },
 };
}

for (const { name, resources, expected } of cases) for (const grant of [false, true]) {
 test(`public deploy permission guidance follows ${name} ${grant ? 'with' : 'without'} a company grant`, async t => {
  const seed = await fixture(t, resources, grant);
  const dry = await seed.run(['--dry-run']);
  const planLine = dry.text.split('\n').find(line => line.includes('Cloudflare token permissions:'));
  assert.ok(planLine, dry.text);
  assertPermissions(planLine, expected);
  const needed = dry.text.slice(dry.text.indexOf('Needed for a real deploy'));
  assertCredentialHelp(needed, expected, grant);

  const refused = await seed.run(['--json'], 3);
  const events = refused.stdout.trim().split('\n').map(JSON.parse);
  const failure = events.find(event => event.event === 'error');
  assert.ok(failure, refused.text);
  assertCredentialHelp(failure.message, expected, grant);
  assert.ok(failure.message.includes('CLOUDFLARE_ACCOUNT_ID') && failure.message.includes('CLOUDFLARE_API_TOKEN'), failure.message);

  // Supplied credentials suppress the missing-input hint, but the local plan
  // must still explain which permissions a real deployment will exercise.
  const supplied = await seed.run(['--dry-run', '--env-file', join(seed.root,'deploy.env')]);
  const suppliedPlan = supplied.text.split('\n').find(line => line.includes('Cloudflare token permissions:'));
  assert.ok(suppliedPlan, supplied.text);
  assertPermissions(suppliedPlan, expected);
  assert.doesNotMatch(supplied.text, /Create an account API token|This run uses a company grant/);
 });
}
