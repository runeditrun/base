import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createState } from './state.mjs';
import { adapterFeatures, localInstaller, ownerAccountHosting } from './adapter.mjs';
import { localVariables } from './local/environment.mjs';

// Test-only application: an operator-auth shaped bootstrap and magic-link,
// /health, and the listing markup of Base modules/mail/src/development (kept
// inline so this suite also runs in a seed's scripts/base-onboarding copy; the
// default-seed installer journey checks the real outbox).
const application = `
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const listing = (rows, path) => rows.map(row => '<article><h2>' + escape(row.message.subject) + '</h2><p>To: ' + escape(row.message.to.join(', ')) + '</p><p><a href="' + escape(path + '?message=' + encodeURIComponent(row.id)) + '">Read message</a></p></article>').join('') || '<p>No messages yet.</p>';
const port = Number(process.argv[2]), origin = 'http://127.0.0.1:' + port;
const vars = parseEnv(readFileSync('.dev.vars', 'utf8'));
appendFileSync('app-events.jsonl', JSON.stringify({ event: 'start', pid: process.pid, origin: vars.AUTH_ORIGIN, inherited: process.env.APP_SECRET_SENTINEL ?? null }) + '\\n');
const outbox = existsSync('outbox.json') ? JSON.parse(readFileSync('outbox.json', 'utf8')) : [];
const body = request => new Promise(resolve => { let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => resolve(text)); });
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
http.createServer(async (request, response) => {
 const url = new URL(request.url, origin);
 if (url.pathname === '/health') return json(response, 200, { status: 'ok' });
 if (request.method === 'POST' && request.headers.origin !== origin) return json(response, 403, { error: 'forbidden_origin' });
 if (request.method === 'POST') appendFileSync('proofs.log', (request.headers['x-rer-local-cli'] ?? '') + '\\n');
 if (url.pathname === '/auth/bootstrap') {
  const input = JSON.parse(await body(request));
  if (input.token !== vars.SETUP_TOKEN) return json(response, 400, { error: 'invalid_token' });
  if (existsSync('claimed.json')) return json(response, 409, { error: 'already_initialized' });
  writeFileSync('claimed.json', JSON.stringify({ email: vars.OWNER_EMAIL, displayName: input.displayName }));
  response.writeHead(303, { location: input.returnTo, 'set-cookie': 'session=fixture' }); return response.end();
 }
 if (url.pathname === '/auth/magic-link') {
  const input = JSON.parse(await body(request));
  outbox.unshift({ id: 'm' + outbox.length + '-' + process.pid, createdAt: Date.now(), message: { to: [input.email], subject: 'Sign in', text: origin + '/auth/confirm?token=fixture' } });
  writeFileSync('outbox.json', JSON.stringify(outbox));
  return json(response, 202, { status: 'accepted' });
 }
 if (url.pathname === '/__dev/outbox') { if (process.env.RER_DEV_KEY && request.headers['x-rer-dev-key'] !== process.env.RER_DEV_KEY) return json(response, 404, { error: 'not_found' }); response.writeHead(200, { 'content-type': 'text/html' }); return response.end(listing(outbox, '/__dev/outbox')); }
 json(response, 404, { error: 'not_found' });
}).listen(port, '127.0.0.1');
`;

async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'adapter-kit-'));
 await mkdir(join(root, 'bin'));
 await writeFile(join(root, 'app.mjs'), application);
 await writeFile(join(root, 'build.mjs'), `import { existsSync, writeFileSync } from 'node:fs';
if (process.env.FAIL_BUILD) { console.log('build output before failure'); process.exit(3); }
writeFileSync('build.json', JSON.stringify({ varsPresent: existsSync('.dev.vars'), nested: Boolean(process.env.RER_LOCAL_OPERATION), session: process.env.SESSION_SECRET ?? null }));`);
 await writeFile(join(root, 'migrate.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync('migrations.log', 'applied\\n');`);
 // A tool the requirements check looks for on PATH.
 await writeFile(join(root, 'bin/fixture-tool'), '#!/bin/sh\nexit 0\n'); await chmod(join(root, 'bin/fixture-tool'), 0o700);
 const stores = [];
 t.after(async () => { for (const store of stores) await store.closeCommands(); await rm(root, { recursive: true, force: true }); });
 const open = async () => { const store = await createState(root, { product: 'Adapter fixture', model: { safeKeys: ['email', 'displayName'] } }); stores.push(store); return store; };
 return { root, open };
}

const node = process.execPath;
function hooks(overrides = {}) {
 return {
  features: { localTrialWithoutEmail: true },
  tools: [], dependencies: false,
  secrets: {
   originKey: 'AUTH_ORIGIN', generate: ['SESSION_SECRET', 'SETUP_TOKEN'],
   values: ({ input, origin }) => ({ OWNER_EMAIL: input.email, AUTH_LOCAL: 'true', AUTH_ORIGIN: origin, MAIL_PROVIDER: 'development' }),
  },
  build: [node, ['build.mjs']],
  migrate: [node, ['migrate.mjs']],
  start: ({ origin }) => [node, ['app.mjs', new URL(origin).port], { env: { ...process.env, APP_SECRET_SENTINEL: 'inherited' } }],
  owner: { displayName: input => input.displayName },
  signIn: { emailKey: 'OWNER_EMAIL' },
  ...overrides,
 };
}
const input = { email: 'owner@example.test', displayName: 'First Owner' };

async function installOnce(f, kit, { signal } = {}) {
 const store = await f.open();
 let app;
 await kit.install(f.root, input, store, child => { app = child; }, signal);
 return { store, app };
}

test('feature flags must describe the hooks the adapter really runs', () => {
 assert.throws(() => adapterFeatures({}, { localTrialWithoutEmail: true }), /localTrialWithoutEmail needs a signIn hook/);
 assert.throws(() => adapterFeatures({}, { hosting: true }), /features.hosting needs a hosting hook/);
 assert.throws(() => adapterFeatures({ hosting: [] }, {}), /hosting hook must be declared/);
 assert.deepEqual(adapterFeatures({ signIn: {} }, { localTrialWithoutEmail: true }), { hosting: false, github: false, artwork: false, localTrialWithoutEmail: true });
 assert.throws(() => localInstaller({ migrations: [] }), /Unknown installer hook: migrations/);
});

test('a complete install generates private settings, hides them from the build, claims the owner and ends at the outbox message', async t => {
 const f = await fixture(t);
 const { store, app } = await installOnce(f, localInstaller(hooks()));
 t.after(async () => { if (app) await store.stop(app); });
 assert.equal(store.state.phase, 'complete', store.state.error);
 const varsPath = join(f.root, '.dev.vars'), text = await readFile(varsPath, 'utf8'), vars = localVariables(text);
 assert.equal((await stat(varsPath)).mode & 0o777, 0o600);
 assert.match(vars.SESSION_SECRET, /^[a-f0-9]{64}$/); assert.match(vars.SETUP_TOKEN, /^[a-f0-9]{64}$/);
 assert.equal(vars.OWNER_EMAIL, input.email); assert.match(vars.AUTH_ORIGIN, /^http:\/\/127\.0\.0\.1:\d+$/);
 assert.deepEqual(JSON.parse(await readFile(join(f.root, 'build.json'), 'utf8')), { varsPresent: false, nested: true, session: null }, 'the build ran without .dev.vars, inside the operation');
 assert.equal(await readFile(join(f.root, 'migrations.log'), 'utf8'), 'applied\n');
 assert.deepEqual(JSON.parse(await readFile(join(f.root, 'claimed.json'), 'utf8')), { email: input.email, displayName: input.displayName });
 const outbox = new URL(store.state.appUrl);
 assert.equal(outbox.origin, vars.AUTH_ORIGIN); assert.equal(outbox.pathname, '/__dev/outbox'); assert.match(outbox.searchParams.get('message'), /^m0-/);
 assert.equal(app.exitCode, null, 'the application keeps running for the owner');
 assert.equal(store.state.devOpen, undefined, 'a seed without devIdentity offers no key exchange');
 assert.deepEqual(await readdirSafe(join(f.root, '.rer')), [], 'and gets no dev key');
 const log = await readFile(store.logPath, 'utf8');
 for (const secret of [vars.SESSION_SECRET, vars.SETUP_TOKEN]) { assert.ok(!log.includes(secret)); assert.ok(!JSON.stringify(store.state).includes(secret)); }
 assert.match(log, /First owner claimed/); assert.match(log, /sign-in link is waiting in the development outbox/);
 assert.deepEqual(await proofs(f), Array(2).fill(localCliProof(vars.SESSION_SECRET)), 'the default session secret setting is SESSION_SECRET');
 assert.deepEqual(await readdirSafe(join(f.root, '.wrangler/local-build')), [], 'the build restored .dev.vars and removed its run folder');
});

test('a devIdentity seed\'s install gives the temporary app the dev key and offers the key-gated way in', async t => {
 const f = await fixture(t);
 await mkdir(join(f.root, 'scripts/installer'), { recursive: true });
 await writeFile(join(f.root, 'OPERATIONS.json'), JSON.stringify({ seedContract: { adapter: 'scripts/installer/local.mjs' } }));
 await writeFile(join(f.root, 'scripts/installer/local.mjs'), 'export const commandAdapter = { devIdentity: { entry: "src/server.dev.ts" } };\n');
 const gated = hooks({ start: ({ origin, devKey }) => [node, ['app.mjs', new URL(origin).port], { env: { ...process.env, RER_DEV_KEY: devKey } }] });
 const { store, app } = await installOnce(f, localInstaller(gated));
 t.after(async () => { if (app) await store.stop(app); });
 // Sign-in reached the outbox only through the key gate, and the key never enters state or the log.
 assert.equal(store.state.phase, 'complete', store.state.error);
 assert.equal(store.state.devOpen, true);
 const keyFile = join(f.root, '.rer/local/dev-key.env'), key = /^RER_DEV_KEY=(\S+)$/m.exec(await readFile(keyFile, 'utf8'))[1];
 assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
 assert.equal((await fetch(store.state.appUrl)).status, 404, 'the outbox is closed without the key');
 assert.equal((await fetch(store.state.appUrl, { headers: { 'x-rer-dev-key': key } })).status, 200);
 assert.ok(!JSON.stringify(store.state).includes(key) && !(await readFile(store.logPath, 'utf8')).includes(key));
});

const proofs = async f => (await readFile(join(f.root, 'proofs.log'), 'utf8')).trim().split('\n');
const localCliProof = secret => createHmac('sha256', secret).update('local-cli\0sign-in').digest('hex');

test('the CLI\'s local sign-in proof comes from the setting the adapter declares as its session secret', async t => {
 const f = await fixture(t);
 const { store, app } = await installOnce(f, localInstaller(hooks({ sessionSecretKey: 'AUTH_SECRET', secrets: { ...hooks().secrets, generate: ['AUTH_SECRET', 'SETUP_TOKEN'] } })));
 t.after(async () => { if (app) await store.stop(app); });
 assert.equal(store.state.phase, 'complete', store.state.error);
 const vars = localVariables(await readFile(join(f.root, '.dev.vars'), 'utf8'));
 assert.equal(vars.SESSION_SECRET, undefined);
 assert.deepEqual(await proofs(f), Array(2).fill(localCliProof(vars.AUTH_SECRET)), 'claim and sign-in request both carry the proof');
 assert.throws(() => localInstaller({ sessionSecretKey: 'auth secret' }), /sessionSecretKey must name a setting/);
});

test('setup stops before the claim when another process answers on the port the application did not bind', async t => {
 const f = await fixture(t);
 const requests = [];
 const foreign = http.createServer((request, response) => { requests.push(request.method + ' ' + request.url); response.writeHead(request.url === '/health' ? 200 : 404); response.end('{"status":"ok"}'); });
 foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
 t.after(() => foreign.close());
 const origin = 'http://127.0.0.1:' + foreign.address().port;
 // The started application never binds the port, as when the foreign app wins the race for it.
 const kit = localInstaller(hooks({ origin: () => origin, start: [node, ['-e', 'setInterval(() => {}, 1000)']] }));
 const store = await f.open();
 let app;
 await kit.install(f.root, input, store, child => { app = child; });
 assert.equal(store.state.phase, 'failed');
 assert.match(store.state.error.split('\n')[0], /Another process answered on port \d+; the application did not bind it/);
 assert.deepEqual(requests.filter(request => request.startsWith('POST')), [], 'no claim or sign-in request reached the other app');
 assert.notEqual(app.exitCode ?? app.signalCode, null, 'the started application was stopped');
});

test('a rerun keeps the owner\'s settings, origin and claimed owner', async t => {
 const f = await fixture(t);
 const first = await installOnce(f, localInstaller(hooks()));
 assert.equal(first.store.state.phase, 'complete', first.store.state.error);
 await first.store.stop(first.app);
 const varsPath = join(f.root, '.dev.vars');
 // The owner edits the file: an added comment and setting survive unchanged.
 await writeFile(varsPath, (await readFile(varsPath, 'utf8')) + '# owner comment\nEXTRA_SETTING=kept\n');
 const before = await readFile(varsPath);
 const second = await installOnce(f, localInstaller(hooks()));
 t.after(async () => { if (second.app) await second.store.stop(second.app); });
 assert.equal(second.store.state.phase, 'complete', second.store.state.error);
 assert.ok((await readFile(varsPath)).equals(before), 'the exact owner file was kept');
 assert.equal(new URL(second.store.state.appUrl).origin, localVariables(before.toString()).AUTH_ORIGIN, 'the saved origin was reused');
 assert.match(await readFile(second.store.logPath, 'utf8'), /An owner is already claimed; the existing owner was kept/);
 assert.match(new URL(second.store.state.appUrl).searchParams.get('message'), /^m1-/, 'the new sign-in message, not the first one');
});

test('missing settings are added after the owner\'s exact existing lines', async t => {
 const f = await fixture(t);
 const existing = '# private comment\nOWNER_EMAIL=kept@example.test\nAUTH_ORIGIN=http://127.0.0.1:1\n';
 await writeFile(join(f.root, '.dev.vars'), existing, { mode: 0o640 });
 const { store } = await installOnce(f, localInstaller(hooks({ build: false, migrate: false, start: false, owner: false, signIn: false, features: {} })));
 assert.equal(store.state.phase, 'complete', store.state.error);
 const text = await readFile(join(f.root, '.dev.vars'), 'utf8');
 assert.ok(text.startsWith(existing));
 const vars = localVariables(text);
 assert.equal(vars.OWNER_EMAIL, 'kept@example.test'); assert.equal(vars.AUTH_ORIGIN, 'http://127.0.0.1:1');
 assert.deepEqual(Object.keys(vars).sort(), ['AUTH_LOCAL', 'AUTH_ORIGIN', 'MAIL_PROVIDER', 'OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN']);
 assert.deepEqual(text.slice(existing.length).split('\n').map(line => line.split('=')[0]), ['AUTH_LOCAL', 'MAIL_PROVIDER', 'SESSION_SECRET', 'SETUP_TOKEN', '']);
 assert.equal((await stat(join(f.root, '.dev.vars'))).mode & 0o777, 0o600);
});

test('JSON settings files are generated with the requested encoding and kept on rerun', async t => {
 const f = await fixture(t);
 const kit = localInstaller(hooks({ secrets: { file: 'data/local-secrets.json', format: 'json', encoding: 'base64url', generate: ['SESSION_SECRET', 'RUNNER_KEY'] }, build: false, migrate: false, start: false, owner: false, signIn: false, features: {} }));
 const first = await installOnce(f, kit);
 assert.equal(first.store.state.phase, 'complete', first.store.state.error);
 const path = join(f.root, 'data/local-secrets.json'), saved = await readFile(path);
 const values = JSON.parse(saved);
 assert.deepEqual(Object.keys(values), ['SESSION_SECRET', 'RUNNER_KEY']);
 for (const value of Object.values(values)) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
 assert.equal((await stat(path)).mode & 0o777, 0o600);
 await installOnce(f, kit);
 assert.ok((await readFile(path)).equals(saved));
});

test('a failed build is a canned failure with the captured diagnostic, restores .dev.vars and starts nothing', async t => {
 const f = await fixture(t);
 const kit = localInstaller(hooks({ build: [node, ['build.mjs'], { env: { ...process.env, FAIL_BUILD: '1' } }] }));
 let started = false;
 const store = await f.open();
 await kit.install(f.root, input, store, () => { started = true; });
 assert.equal(store.state.phase, 'failed');
 const [headline, guidance] = store.state.error.split('\n');
 assert.equal(headline, 'Building your application: exit 3, signal none.');
 assert.match(guidance, /^Installation stopped while building the application\./);
 assert.match(store.state.error, /build output before failure\nLog: .*install\.log$/);
 assert.equal(started, false);
 assert.ok(localVariables(await readFile(join(f.root, '.dev.vars'), 'utf8')).SETUP_TOKEN, '.dev.vars restored after the failed build');
 assert.deepEqual(await readdirSafe(join(f.root, '.wrangler/local-build')), []);
});

test('requirements fail with canned Node and tool messages before any command', async t => {
 const f = await fixture(t);
 assert.throws(() => localInstaller({ tools: ['definitely-not-a-supported-tool'] }), /Unsupported required tool/);
 for (const [extra, expected] of [[{ node: '999.0.0' }, /^Install Node\.js 999\.0\.0/], [{ tools: ['npm'] }, /^npm was not found/]]) {
  const store = await f.open();
  const path = process.env.PATH;
  if (extra.tools?.includes('npm')) process.env.PATH = join(f.root, 'bin');
  try { await localInstaller(hooks(extra)).install(f.root, input, store, () => {}); } finally { process.env.PATH = path; }
  assert.equal(store.state.phase, 'failed');
  assert.match(store.state.error, expected);
  await assert.rejects(stat(join(f.root, '.dev.vars')), { code: 'ENOENT' }, 'nothing ran');
 }
});

test('a rejected owner claim stops the started application before reporting failure', async t => {
 const f = await fixture(t);
 const kit = localInstaller(hooks({ owner: { tokenKey: 'SESSION_SECRET' } }));
 const store = await f.open();
 let app, closed = false;
 const phase = store.phase.bind(store);
 store.phase = async value => { if (value === 'failed') assert.ok(closed, 'failure follows application close'); await phase(value); };
 await kit.install(f.root, input, store, child => { app = child; child.once('close', () => { closed = true; }); });
 assert.equal(store.state.phase, 'failed');
 assert.match(store.state.error.split('\n')[0], /HTTP 400.*invalid_token/);
 assert.match(store.state.logs.join('\n'), /HTTP 400.*invalid_token/);
 assert.notEqual(app.exitCode ?? app.signalCode, null);
 await assert.rejects(stat(join(f.root, 'claimed.json')), { code: 'ENOENT' }, 'the rejected token claims no owner');
 await assert.rejects(stat(join(f.root, 'outbox.json')), { code: 'ENOENT' }, 'a rejected claim issues no sign-in message');
 const vars = localVariables(await readFile(join(f.root, '.dev.vars'), 'utf8'));
 await assert.rejects(fetch(vars.AUTH_ORIGIN + '/health'), 'the rejected claim leaves no application listener');
});

test('cancelling while the application starts stops it and reports a stop, not a failure', async t => {
 const f = await fixture(t);
 const abort = new AbortController();
 const kit = localInstaller(hooks({ start: ({ origin }) => [node, ['-e', "setInterval(()=>{},1000)"], { health: '/never' }] }));
 const store = await f.open();
 store.setCommandSignal(abort.signal);
 let app;
 const pending = kit.install(f.root, input, store, child => { app = child; setTimeout(() => abort.abort(), 200); }, abort.signal);
 await pending;
 assert.equal(store.state.phase, 'failed');
 assert.match(store.state.error.split('\n')[0], /cancelled/);
 if (app.exitCode === null && app.signalCode === null) await once(app, 'close');
});

// Test-only stand-in for deploy-kit owner-cli.mjs: records the command and
// which inputs it received (never their values) and writes the owner state.
const ownerCli = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
appendFileSync('owner-cli.jsonl', JSON.stringify({ command, args, account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN === process.env.EXPECTED_TOKEN, secret: process.env.AUTH_SECRET === process.env.EXPECTED_SECRET }) + '\\n');
if (process.env.FAIL_DEPLOY && command === 'deploy') { console.error(JSON.stringify({ ok: false, code: 'resource-name-collision' })); process.exit(1); }
if (command === 'deploy') { mkdirSync('.rer/deploy', { recursive: true }); writeFileSync('.rer/deploy/production.json', JSON.stringify({ receipt: { origin: 'https://fixture-production.example.workers.dev' } })); }
console.log(JSON.stringify({ ok: true, command, token: process.env.CLOUDFLARE_API_TOKEN }));
`;
const account = 'a'.repeat(32), token = 'test-synthetic-cloudflare-token-value';
function hosting(extra = {}) {
 return hooks({ features: { localTrialWithoutEmail: true, hosting: true }, hosting: ownerAccountHosting({ cli: 'owner-cli.mjs', secrets: ({ vars }) => ({ AUTH_SECRET: vars.SESSION_SECRET }) }), ...extra });
}

test('owner-account hosting deploys with the owner\'s account and token, checks health and keeps the token out of every sink', async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, 'owner-cli.mjs'), ownerCli);
 const store = await f.open();
 let app;
 const path = process.env.EXPECTED_TOKEN;
 process.env.EXPECTED_TOKEN = token;
 await writeFile(join(f.root, '.dev.vars'), 'SESSION_SECRET=test-synthetic-session-value-for-hosting\n', { mode: 0o600 });
 process.env.EXPECTED_SECRET = 'test-synthetic-session-value-for-hosting';
 try { await localInstaller(hosting()).install(f.root, { ...input, target: 'remote', accountId: account, apiToken: token }, store, child => { app = child; }); }
 finally { process.env.EXPECTED_TOKEN = path; delete process.env.EXPECTED_SECRET; }
 t.after(async () => { if (app) await store.stop(app); });
 assert.equal(store.state.phase, 'complete', store.state.error);
 const calls = (await readFile(join(f.root, 'owner-cli.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(call => [call.command, ...call.args]), [['deploy', '--declaration', 'deploy.json', '--environment', 'production'], ['health', '--declaration', 'deploy.json', '--environment', 'production']]);
 assert.ok(calls.every(call => call.account === account && call.token && call.secret));
 assert.equal(store.state.hostedUrl, 'https://fixture-production.example.workers.dev');
 assert.match(store.state.appUrl, /\/__dev\/outbox\?message=/, 'the local trial still ends at the outbox');
 const log = await readFile(store.logPath, 'utf8');
 assert.match(log, /Deployed to https:\/\/fixture-production\.example\.workers\.dev/);
 assert.ok(!log.includes(token) && !JSON.stringify(store.state).includes(token), 'the API token never reaches the log or state');
});

test('owner-account hosting keeps local work offline and refuses failed deployment', async t => {
 const f = await fixture(t);
 await writeFile(join(f.root, 'owner-cli.mjs'), ownerCli);
 const local = await f.open();
 let app;
 await localInstaller(hosting()).install(f.root, { ...input, target: 'local' }, local, child => { app = child; });
 assert.equal(local.state.phase, 'complete', local.state.error);
 await local.stop(app);
 await assert.rejects(stat(join(f.root, 'owner-cli.jsonl')), { code: 'ENOENT' });
 for (const [answers, env, expectedCalls] of [
  [{ target: 'remote', accountId: 'not-an-account', apiToken: token }, {}, []],
  [{ target: 'remote', accountId: account, apiToken: token }, { FAIL_DEPLOY: '1' }, ['deploy']],
 ]) {
  const store = await f.open();
  Object.assign(process.env, env);
  try { await localInstaller(hosting()).install(f.root, { ...input, ...answers }, store, child => { app = child; }); } finally { for (const key of Object.keys(env)) delete process.env[key]; }
  assert.equal(store.state.phase, 'failed');
  const calls = (await readFile(join(f.root, 'owner-cli.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(calls.map(call => call.command), expectedCalls, 'invalid accounts make no provider call; the failed provider attempt runs deploy once');
  if (expectedCalls.length) assert.match(store.state.error, /exit 1, signal none/);
  await assert.rejects(stat(join(f.root, '.rer/deploy/production.json')), { code: 'ENOENT' }, 'failed deployment writes no success state');
  assert.notEqual(app.exitCode ?? app.signalCode, null, 'failed hosting stops the local application');
  assert.ok(!store.state.error.includes(token));
 }
 assert.throws(() => ownerAccountHosting({}), { name: 'TypeError' });
});

async function readdirSafe(path) {
 const { readdir } = await import('node:fs/promises');
 try { return await readdir(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
