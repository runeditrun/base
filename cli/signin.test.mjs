import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { signinCommand } from './signin.mjs';
import { main } from './main.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';
import { runtime } from '../modules/operator-auth/tests/runtime.mjs';
import { ownerSigninDigest } from '../modules/operator-auth/owner-signin-grant.mjs';

// rer signin against the fake Cloudflare account (the only fake, at the network
// edge) whose D1 query API reads and writes the hosted Worker's real D1 in workerd.

async function hosted(t) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-signin-'))); t.after(() => rm(root, { recursive: true, force: true }));
 for (const path of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, path), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default {fetch(){}}');
 await writeFile(join(root, 'dist/client/index.html'), 'app');
 await writeFile(join(root, 'migrations/core/0001_app.sql'), 'CREATE TABLE app(id TEXT PRIMARY KEY);');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', d1: [{ binding: 'DB' }] }));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n');
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'first');
 const provider = ownerProvider();
 t.after(() => provider.close());
 const credentials = { CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token };
 await ownerKit(['deploy', '--declaration', 'deploy.json', '--environment', 'production'], credentials, { cwd: root, fetch: provider.fetch });
 // The hosted Worker: Base operator-auth over its own D1, with the owner claimed.
 const app = await runtime();
 t.after(() => app.close());
 const db = await app.db;
 await db.prepare(await readFile(new URL('../modules/operator-auth/accounts/schema/owner-signin.sql', import.meta.url), 'utf8')).run();
 const ownerCookie = await app.bootstrap();
 await db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES('member-1','member@example.com','Member','member','active',1)").run();
 const uuid = provider.state.databases[0].uuid, calls = [];
 // D1 query API calls for the deployment's database run on the Worker's D1.
 const fetch = async (input, init = {}) => {
  const path = new URL(input).pathname;
  if (path.endsWith(`/d1/database/${uuid}/query`)) {
   calls.push(JSON.parse(init.body).sql);
   const result = await db.prepare(JSON.parse(init.body).sql).all();
   return Response.json({ success: true, errors: [], result: [{ success: true, results: result.results, meta: result.meta }] });
  }
  return provider.fetch(input, init);
 };
 const project = { root, profile: 'first-party', adapter: { deploy: Object.assign(async () => {}, { declaration: 'deploy.json' }) } };
 const signin = async (env = credentials, options = {}) => {
  const saved = Object.fromEntries(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].map(name => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  Object.assign(process.env, env);
  const lines = [];
  try { return { ...await signinCommand(project, { environment: 'production', ...options }, { human: line => lines.push(line) }, { fetch }), lines }; }
  finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
 };
 const token = lines => new URL(lines.join('\n').match(/https:\/\/\S+/)[0]).searchParams.get('token');
 const use = value => app.call('/auth/owner-signin', { method: 'POST', input: { token: value } });
 return { root, app, db, calls, signin, token, use, ownerCookie, fetch, credentials };
}

async function files(directory) {
 const out = [];
 for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) if (entry.isFile() && !entry.parentPath.includes('/.git')) out.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
 return out;
}

test('rer signin gives the recorded owner a one-time link without mail; its use is logged and lets the owner correct the email', async t => {
 const h = await hosted(t);
 const result = await h.signin();
 assert.equal(result.owner, 'owner@example.com');
 assert.ok(result.expiresAt - Date.now() <= 15 * 60000 && result.expiresAt - Date.now() > 14 * 60000);
 assert.equal(result.link, undefined, 'the link is printed, not returned as data');
 const text = result.lines.join('\n'), token = h.token(result.lines);
 assert.equal(text.split(token).length, 2, 'the link is printed exactly once');
 assert.match(text, /https:\/\/fixture-production\.[a-z0-9-]+\.workers\.dev\/auth\/owner-signin\?token=/);
 // Only the digest reached the database, and the token is in no file the checkout keeps.
 assert.equal(h.calls.some(sql => sql.includes(token)), false);
 assert.equal((await h.db.prepare('SELECT token_hash FROM oa_owner_signins').first()).token_hash, await ownerSigninDigest(token));
 assert.equal((await files(h.root)).some(content => content.includes(token)), false);
 // A GET only shows the confirmation; it does not sign in (link scanners).
 const page = await h.app.call(`/auth/owner-signin?token=${token}`);
 assert.equal(page.status, 200);
 assert.match(await page.text(), /Sign in as the owner of/);
 const used = await h.use(token);
 assert.equal(used.status, 303);
 const cookie = used.headers.get('set-cookie');
 assert.match(cookie, /^__Host-operator_session=[^;]+;.*; Secure$/);
 const session = await (await h.app.call('/auth/session', { cookie: cookie.split(';')[0] })).json();
 assert.equal(session.operator.email, 'owner@example.com');
 assert.equal(session.operator.role, 'owner');
 const audit = await h.db.prepare("SELECT actor_id FROM oa_auth_audit WHERE action='owner:signin-link'").all();
 assert.deepEqual(audit.results.map(row => row.actor_id), [session.operator.id]);
 // A second use fails, and its page says so.
 assert.equal((await h.use(token)).status, 400);
 assert.equal((await h.app.call(`/auth/owner-signin?token=${token}`)).status, 400);
 // The owner's wrong email: this fresh session may change it; an older session may not.
 const stale = await h.app.call('/auth/email', { method: 'POST', input: { email: 'owner-real@example.com' }, cookie: h.ownerCookie });
 assert.equal(stale.status, 403);
 assert.deepEqual(await stale.json(), { error: 'step_up_required' });
 const changed = await h.app.call('/auth/email', { method: 'POST', input: { email: 'owner-real@example.com' }, cookie: cookie.split(';')[0] });
 assert.equal(changed.status, 200);
 assert.equal((await changed.json()).email, 'owner-real@example.com');
 assert.equal((await h.app.call('/auth/email', { method: 'POST', input: { email: 'member@example.com' }, cookie: cookie.split(';')[0] })).status, 409, 'an address another operator holds is refused');
 // The next link names the corrected owner.
 assert.equal((await h.signin()).owner, 'owner-real@example.com');
});

test('an owner link is refused when expired, minted for a non-owner, or without the deploy credentials', async t => {
 const h = await hosted(t);
 const realNow = Date.now;
 const at = async offset => { t.mock.method(Date, 'now', () => realNow() + offset); try { return await h.signin(); } finally { Date.now.mock.restore(); } };
 // Minted 16 minutes ago: expired.
 const expired = h.token((await at(-16 * 60000)).lines);
 assert.equal((await h.use(expired)).status, 400);
 // Minted by a clock a day ahead: the Worker never honours more than 15 minutes from its own now.
 const ahead = h.token((await at(86400000)).lines);
 assert.equal((await h.use(ahead)).status, 400);
 // A grant naming a member, as anyone writing the table directly could make: refused.
 const member = 'm'.repeat(43);
 await h.db.prepare(`INSERT INTO oa_owner_signins(id,token_hash,operator_id,operator_version,created_at,expires_at) VALUES('g-member',?,'member-1',1,?,?)`).bind(await ownerSigninDigest(member), realNow(), realNow() + 600000).run();
 assert.equal((await h.app.call(`/auth/owner-signin?token=${member}`)).status, 400);
 assert.equal((await h.use(member)).status, 400);
 assert.equal((await h.db.prepare("SELECT count(*) AS n FROM oa_auth_audit WHERE action='owner:signin-link'").first()).n, 0, 'no refused link signed anyone in');
 // Without the Cloudflare credentials nothing is asked of the provider and nothing is written.
 const before = h.calls.length;
 await assert.rejects(h.signin({}), error => error.exitCode === 3 && /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/.test(error.message));
 await assert.rejects(h.signin({ CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'another-account' }), error => error.exitCode !== 0);
 assert.equal(h.calls.length, before);
 assert.equal((await h.db.prepare('SELECT count(*) AS n FROM oa_owner_signins').first()).n, 3);
});

test('rer signin directs native-auth owners to their declared page or setup recovery without issuing a link', async t => {
 const saved = { ...process.env };
 t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); });
 for (const signInPath of ['/login', undefined]) {
  const h = await hosted(t);
  await h.db.prepare('DROP TABLE oa_owner_signins').run();
  await writeFile(join(h.root, '.node-version'), process.versions.node);
  await writeFile(join(h.root, 'adapter.mjs'), `export const commandAdapter = {deploy: Object.assign(async()=>{}, {declaration:'deploy.json'}), ...${JSON.stringify({ signInPath })}};`);
  await writeFile(join(h.root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'tests/fixture', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { deploy: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs', 'deploy.json'], effects: 'Manage the test deployment.' } } }));
  Object.assign(process.env, h.credentials);
  const network = t.mock.method(globalThis, 'fetch', h.fetch), lines = [];
  const stdout = t.mock.method(process.stdout, 'write', text => { lines.push(String(text)); return true; });
  let exit;
  try { exit = await main(['signin', '--cwd', h.root, '--json']); }
  finally { stdout.mock.restore(); network.mock.restore(); }
  assert.equal(exit, 4, lines.join(''));
  const events = lines.join('').trim().split('\n').map(line => JSON.parse(line));
  const failure = events.find(event => event.event === 'error');
  assert.match(failure.message, /seed's own sign-in/i);
  const destination = new URL(failure.message.match(/https:\/\/\S+/)[0]);
  const record = JSON.parse(await readFile(join(h.root, '.rer/deploy/production.json'), 'utf8'));
  assert.equal(destination.origin, record.receipt.origin);
  assert.equal(destination.pathname, signInPath ?? '/setup');
  assert.ok(h.calls.length > 0 && h.calls.every(sql => /^SELECT\b/.test(sql)), 'native sign-in refuses without writing an owner grant');
  assert.equal(events.at(-1).ok, false);
  t.diagnostic(failure.message);
 }
});
