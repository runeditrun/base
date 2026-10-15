import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';

// Real dispatcher and deploy kit; only the provider and hosted HTTP edge are fake.
test('rer deploy refuses explicit unfinished hosted setup and preserves the same-input recovery', async t => {
 for (const custom of [false, true]) await t.test(custom ? 'custom deploy hook' : 'owner deploy', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rer setup deploy ')));
  const provider = ownerProvider(), probes = [];
  const environment = 'review', origin = 'https://fixture-review.fixture-account.workers.dev';
  const token = 'test-only-native-setup-secret';
  let status = 409, body = { setupRequired: true };
  t.after(async () => { provider.close(); await rm(root, { recursive: true, force: true }); });
  const edge = createServer(async (request, response) => {
   try {
    const destination = new URL(request.headers['x-test-destination']);
    let result;
    if (destination.pathname === '/api/identity/setup-status') {
     probes.push({ origin: destination.origin, method: request.method, redirect: request.headers['x-test-redirect'], authorization: request.headers.authorization, cookie: request.headers.cookie });
     result = Response.json(body, { status, headers: status === 302 ? { location: 'https://other.example.test/setup' } : {} });
    } else {
     const chunks = []; for await (const chunk of request) chunks.push(chunk);
     const headers = { ...request.headers, Authorization: request.headers.authorization };
     const bytes = Buffer.concat(chunks);
     const data = request.headers['content-type']?.startsWith('multipart/form-data') ? await new Response(bytes, { headers }).formData() : bytes.toString();
     result = await provider.fetch(destination.href, { method: request.method, headers, ...(!['GET', 'HEAD'].includes(request.method) ? { body: data } : {}) });
    }
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
   } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
  t.after(async () => { edge.closeAllConnections(); await new Promise(resolve => edge.close(resolve)); });
  for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
  await writeFile(join(root, 'dist/server/index.js'), 'export default {}');
  await writeFile(join(root, 'dist/client/index.html'), 'artifact bytes');
  await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', r2: [{ binding: 'FILES' }], secrets: [{ binding: 'H2H_SETUP_TOKEN', environment: 'H2H_SETUP_TOKEN' }] }));
  await writeFile(join(root, '.node-version'), process.versions.node + '\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
  await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\nowner credentials.env\n');
  await writeFile(join(root, 'owner credentials.env'), `CLOUDFLARE_ACCOUNT_ID=${provider.accountId}\nCLOUDFLARE_API_TOKEN=${provider.token}\nH2H_SETUP_TOKEN=${token}\n`, { mode: 0o600 });
  // Keep transport addresses out of credential-shaped environment names: the
  // real redactor must leave the public deployment origin readable.
  await writeFile(join(root, 'network.mjs'), `const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
 const request = new Request(input, init), url = new URL(request.url);
 if (!['https://api.cloudflare.com', ${JSON.stringify(origin)}].includes(url.origin)) throw Error('Unexpected test network destination');
 const headers = new Headers(request.headers);
 for (const name of ['host', 'connection', 'transfer-encoding']) headers.delete(name);
 headers.set('x-test-destination', request.url); headers.set('x-test-redirect', request.redirect);
 const response = await original(${JSON.stringify(`http://127.0.0.1:${edge.address().port}`)}, {method:request.method, headers,
  ...(!['GET','HEAD'].includes(request.method) ? {body:await request.arrayBuffer()} : {}), signal:request.signal, redirect:'manual'});
 return new Response(response.body, {status:response.status, headers:response.headers});
};`);
  await writeFile(join(root, 'adapter.mjs'), `import { ownerDeploy } from ${JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)};
import { main as owner } from ${JSON.stringify(new URL('../modules/deploy-kit/owner-cli.mjs', import.meta.url).href)};
const lifecycle = { run: async () => {}, settings: {}, hooks: { owner: async () => { throw Error('Unregistered native owner must not be called'); } } };
export const commandAdapter = { ...lifecycle, deployDeclaration: 'deploy.json', deploy: ${custom ? `async ({root, options}) => ({...await owner(['deploy', '--declaration', 'deploy.json', '--environment', options.environment], process.env, {cwd:root}), deployed:true})` : "ownerDeploy('deploy.json', lifecycle)"} };`);
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Deploy the fixture to the fake provider.' } } }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  const args = ['deploy', '--environment', environment, '--env-file', 'owner credentials.env', '--cwd', root, '--json'];
  const run = async () => {
   try { return { code: 0, ...await promisify(execFile)(process.execPath, [new URL('../bin/rer.mjs', import.meta.url).pathname, ...args], {
    cwd: root, env: { ...process.env, CI: 'true', NODE_OPTIONS: `--import="${join(root, 'network.mjs')}"` }, timeout: 30000,
   }) }; } catch (error) { if (typeof error.code !== 'number') throw error; return error; }
  };
  const first = await run(), output = first.stdout + first.stderr;
  assert.equal(first.code, 1, output);
  const events = first.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(event => event.event === 'error')?.code, 'command_failed');
  assert.equal(events.at(-1).ok, false);
  assert.match(output, new RegExp(origin.replaceAll('.', '\\.')));
  assert.match(output, /setup.*required|requires.*setup/i);
  assert.match(output, /owner claim.*not confirmed/i);
  assert.match(output, /fix.*register.*native.*owner.*claim/i);
  assert.ok(output.includes("rer deploy --environment review --env-file 'owner credentials.env' --cwd ."), output);
  assert.doesNotMatch(output, /application is live|Sign in by email|--set-secret|enter.*token/i);
  for (const secret of [token, provider.token, provider.accountId]) assert.ok(!output.includes(secret), 'no credential in command output');
  const statePath = join(root, '.rer/deploy/review.json');
  const state = await readFile(statePath, 'utf8'), record = JSON.parse(state);
  assert.equal(record.ownerClaim, undefined);
  assert.ok(record.receipt && record.owned.worker, 'deployed ownership receipt is retained');
  assert.equal(provider.state.buckets.length, 1);
  assert.equal(provider.state.secrets.find(item => item.name === 'H2H_SETUP_TOKEN')?.value, token, 'unclaimed native token remains untouched');
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0], { origin, method: 'GET', redirect: 'manual', authorization: undefined, cookie: undefined });
  const writes = provider.state.writes.length;
  // Unsupported endpoints and redirects do not impose this optional API on apps.
  for (const [nextStatus, nextBody] of [[404, { setupRequired: true }], [302, { setupRequired: true }], [200, { setupRequired: false }]]) {
   status = nextStatus; body = nextBody;
   const result = await run(); assert.equal(result.code, 0, result.stdout + result.stderr);
   assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).owner, undefined, 'no fabricated owner claim');
   assert.equal(await readFile(statePath, 'utf8'), state, 'read-only probe preserves deployment state');
   assert.equal(provider.state.writes.length, writes, 'an exact repeat makes no provider mutation');
  }
 });
});
