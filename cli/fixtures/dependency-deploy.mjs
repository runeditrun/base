import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, access, appendFile, readdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownerProvider } from '../../modules/deploy-kit/tests/owner-provider.mjs';
import { testProvider } from '../../default-seed/tests/operator-auth/oidc-provider.mjs';
import { commandDiagnostic } from './command-diagnostic.mjs';

// Preserve the public provider client's body, credentials and redirect policy
// through the controlled HTTP edge, including binary signed D1 imports.
export async function accountFetch(account, request) {
  const upload = new URL(request.url).origin === `https://${account.accountId}.r2.cloudflarestorage.com`;
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : upload ? Buffer.from(await request.arrayBuffer()) : request.headers.get('content-type')?.startsWith('multipart/form-data') ? await request.formData() : await request.text();
  const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name === 'authorization' ? 'Authorization' : name === 'content-length' ? 'Content-Length' : name, value]));
  return account.fetch(request.url, { method: request.method, headers, redirect: request.redirect, ...(body === undefined ? {} : { body }) });
}

// Real public deploy CLI, real packaged Worker, controlled account and Auth
// HTTP edges. No adapter, lifecycle operation or application route is replaced.
export async function linkedDeploy(t, f, localOrigin) {
  const origin = 'https://default-seed-reference-production.fixture-account.workers.dev';
  const account = ownerProvider(), provider = await testProvider(origin, 'cli-owner@example.com');
  provider.allowOwnerClaim();
  const contracts = ['oidc-provider@1', 'error-sink@1'], events = [], edgeErrors = [], approvals = new Map();
  const files = Object.fromEntries(contracts.map((name, index) => [name, `deploy-approval-${index}.json`]));
  let runtime, healthGate;
  // Deploy health fetches one built file from the deployed Worker; nothing else may reach it before linking.
  const workerPaths = [];
  t.after(async () => { await runtime?.dispose(); account.close(); });
  const declarationPath = join(f.root, 'deploy.json');
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'));
  declaration.vars = { ...declaration.vars, IDENTITY_PROVIDER: provider.issuer, ERROR_PROVIDER: provider.issuer };
  await writeFile(declarationPath, JSON.stringify(declaration, null, 2) + '\n');
  // Public source only. Local answers, runtime settings and all approvals remain
  // outside the commit inspected by the real owner-account deploy command.
  await appendFile(join(f.root, '.gitignore'), '\n/answers.json\n/approval-*.json\n/deploy-approval-*.json\n');
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('add', '.');
  const tracked = git('diff', '--cached', '--name-only').toString().trim().split('\n');
  assert.equal(tracked.some(path => /(^|\/)(?:answers\.json|.*approval.*\.json|\.dev\.vars|dev-key\.env)$/.test(path)), false);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Deploy fixture public source');

  async function app() {
    if (runtime) return runtime;
    const require = createRequire(await realpath(resolve('default-seed/node_modules/wrangler/package.json')));
    const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
    const { unstable_splitSqlQuery: splitSql } = require('wrangler');
    const config = JSON.parse(await readFile(join(f.root, 'dist/server/wrangler.json'), 'utf8'));
    const bindings = Object.fromEntries(account.state.settings.bindings.filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
    for (const secret of account.state.secrets) bindings[secret.name] = secret.value;
    assert.equal(bindings.AUTH_ORIGIN, origin);
    runtime = new Miniflare({ ...convertV4MiniflareOptions({
      host: '127.0.0.1', port: 0, upstream: origin, modulesRoot: join(f.root, 'dist/server'),
      modules: [config.main, ...(await readdir(join(f.root, 'dist/server/assets'))).filter(file => file.endsWith('.js')).map(file => 'assets/' + file)].map(file => ({ type: 'ESModule', path: join(f.root, 'dist/server', file) })),
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      assets: { directory: join(f.root, 'dist/client'), routerConfig: { has_user_worker: true } },
      bindings, d1Databases: { DB: 'deployed-db' }, queueProducers: { JOBS: 'deployed-jobs' },
      outboundService: async request => {
        assert.equal(new URL(request.url).origin, provider.issuer);
        return provider.fetch(request);
      } }), resourcePersistencePath: join(f.root, '.deploy-edge-runtime') });
    const db = await runtime.getD1Database('DB');
    // Execute exactly the migrations accepted at the account transport edge.
    for (const write of account.state.writes.filter(w => /\/d1\/database\/[^/]+\/(?:query|import)$/.test(w.path))) {
      const statements = splitSql(write.body.sql).map(sql => db.prepare(sql));
      if (write.path.endsWith('/import')) await db.batch(statements);
      else for (const statement of statements) await statement.run();
    }
    return runtime;
  }
  async function workerFetch(worker, input, init) {
    const request = new Request(input, init), headers = new Headers(request.headers);
    assert.equal(new URL(request.url).origin, origin);
    headers.set('Host', new URL(origin).host); headers.set('CF-Connecting-IP', '192.0.2.1');
    return worker.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(headers), redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}) });
  }
  async function dispatch(request) {
    const url = new URL(request.url);
    if (url.origin === 'https://api.cloudflare.com' || url.origin === `https://${account.accountId}.r2.cloudflarestorage.com`) return accountFetch(account, request);
    if (url.origin === origin && url.pathname === '/health') {
      events.push('health-request');
      if (healthGate) { const gate = healthGate; healthGate = undefined; gate.ready(); await gate.wait; }
      const response = await account.fetch(request.url);
      events.push('health-ready');
      return response;
    }
    if (url.origin === origin) { workerPaths.push(url.pathname); return workerFetch(await app(), request); }
    assert.equal(url.origin, provider.issuer);
    if (url.pathname !== '/link') return provider.fetch(request);
    const input = await request.json(), approval = approvals.get(input.interface);
    events.push('initiate');
    assert.ok(events.filter(e => e === 'health-ready').length >= 2);
    assert.equal(input.origin, origin);
    assert.notEqual(input.origin, localOrigin);
    assert.equal(input.token, approval.token);
    assert.equal(approval.used, undefined);
    const worker = await app();
    const call = (path, { method = 'GET', input } = {}) => workerFetch(worker, origin + path, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const documentResponse = await call('/.well-known/rer-dependencies');
    const document = await documentResponse.json();
    if (documentResponse.status !== 200) edgeErrors.push({ status: documentResponse.status, code: typeof document.error === 'string' && /^[a-z_]+$/.test(document.error) ? document.error : 'deployed_document' });
    assert.equal(documentResponse.status, 200, typeof document.error === 'string' && /^[a-z_]+$/.test(document.error) ? document.error : 'deployed-document-status');
    const dependency = document.dependencies.find(d => d.interface === input.interface);
    assert.equal(document.origin, origin);
    assert.equal(document.claim, input.interface === 'oidc-provider@1');
    assert.deepEqual([document.callback, ...dependency.paths].sort(), approval.callbacks.slice().sort());
    approval.used = true;
    const response = await provider.link(call, input.interface);
    assert.equal(response.status, 200, 'packaged Worker accepts the deployed-origin link');
    return response;
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers), target = headers.get('x-test-destination'), redirect = headers.get('x-test-redirect');
      headers.delete('x-test-destination'); headers.delete('x-test-redirect'); headers.delete('host');
      const response = await dispatch(new Request(target, { method: req.method, headers, redirect,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      edgeErrors.push({ name: error.name, at: error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 2), code: /^[a-z_]+$/.test(error.message) ? error.message : undefined, fields: error.issues?.map(issue => ({ path: issue.path, code: issue.code })) });
      events.push('edge-error'); res.writeHead(500); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { NODE_OPTIONS: '--import ' + resolve('cli/fixtures/deploy-network.mjs'),
    AUTH_TEST_DEPLOY_EDGE: 'http://127.0.0.1:' + server.address().port, AUTH_TEST_DEPLOY_ORIGIN: origin,
    CLOUDFLARE_ACCOUNT_ID: account.accountId, CLOUDFLARE_API_TOKEN: account.token,
    OWNER_EMAIL: 'cli-owner@example.com', SESSION_SECRET: 'deploy-fixture-session-secret-thirty-two-bytes', SETUP_TOKEN: 'deploy-fixture-setup-token-thirty-two-bytes', MAIL_API_KEY: 'deploy-fixture-mail-key',
    RER_LINK_TOKEN_FILE: '', RER_LINK_TOKEN_FILES: JSON.stringify(files) };
  const approve = async approvedOrigin => {
    for (const contract of contracts) {
      const paths = contract === 'oidc-provider@1' ? ['/auth/oidc/auth/callback', '/auth/oidc/auth/logout'] : ['/errors/callback'];
      // One instant keeps the approval within its one-hour bound; two clock reads can span 3600001 ms.
      const issuedAt = Date.now();
      const value = { token: crypto.randomUUID(), interface: contract, issuer: provider.issuer, origin: approvedOrigin,
        callbacks: ['/.well-known/rer-link/callback', ...paths].map(p => approvedOrigin + p), issuedAt, expiresAt: issuedAt + 3600000 };
      approvals.set(contract, value); await writeFile(join(f.root, files[contract]), JSON.stringify(value), { mode: 0o600 });
    }
  };
  const deploy = () => f.launch(['scripts/rer.mjs', 'deploy', '--non-interactive', '--json', '--no-queue'], process.execPath, env);
  await approve(localOrigin);
  const wrong = deploy(); const wrongCode=await wrong.done;
  if (wrongCode !== 3) t.diagnostic(JSON.stringify({ stage: 'wrong-origin', exit: wrongCode, events }));
  assert.equal(wrongCode, 3, 'approval for the setup origin is refused');
  assert.equal(events.includes('initiate'), false);
  assert.deepEqual(workerPaths.filter(path => !existsSync(join(f.root, 'dist/client', path))), [], 'only built files reached the deployed Worker');
  assert.equal(workerPaths.length, 1, 'deploy health requested one built file');
  for (const file of Object.values(files)) await access(join(f.root, file));
  assert.equal(account.state.databases[0].db.prepare('SELECT count(*) n FROM rer_dependency_link').get().n, 0);
  events.length = 0;
  await approve(origin);
  let reached, release;
  const ready = new Promise(resolve => { reached = resolve; }), wait = new Promise(resolve => { release = resolve; });
  healthGate = { ready: reached, wait };
  const success = deploy();
  assert.equal(await Promise.race([ready.then(() => 'health'), success.done.then(() => 'exit')]), 'health');
  assert.equal(events.includes('initiate'), false, 'no initiation before readiness');
  release();
  const successCode=await success.done;
  if (successCode !== 0) t.diagnostic(JSON.stringify({ events, edgeErrors, command: commandDiagnostic(success),
    setupApprovalRefused: success.stdoutText.includes('Application setup approval was refused.') }));
  assert.equal(successCode, 0, 'real public deploy and deployed-origin linking complete');
  assert.equal(events.includes('edge-error'), false);
  assert.equal(events.filter(e => e === 'initiate').length, 2);
  for (const file of Object.values(files)) await assert.rejects(access(join(f.root, file)));
  const result = JSON.parse(success.stdoutText.trim().split('\n').at(-1));
  assert.equal(result.origin, origin); assert.equal(result.deployed, true);
  for (const value of approvals.values()) { assert.equal(value.used, true); assert.equal(success.stdoutText.includes(value.token), false); assert.equal(success.stderrText.includes(value.token), false); }
  const call = (path, options = {}) => workerFetch(runtime, origin + path, options);
  assert.equal((await (await call('/.well-known/rer-dependencies')).json()).claim, false);
  const start = await call('/auth/oidc/auth/start', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(start.status, 303);
  const callback = await call(await provider.grant(start.headers.get('location')), { headers: { Cookie: start.headers.get('set-cookie') } });
  assert.equal(callback.status, 303);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-operator_session=')).split(';')[0];
  const session = await call('/auth/session', { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).operator.email, env.OWNER_EMAIL);
  const setting = await call('/auth/settings/identity', { headers: { Cookie: cookie } });
  assert.equal(setting.status, 200); assert.equal((await setting.json()).idpSignIn, true);
  await runtime.dispose(); runtime = undefined;
  t.diagnostic('Controlled deploy: wrong-origin approval exit 3 with no initiation; ready returned origin accepts both exact-scope approvals, consumes both private files, completes owner claim and authenticated settings.');
}
