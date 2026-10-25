import { productionSender } from './fixtures/production-sender.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runCommand } from './lifecycle.mjs';
import { ownerProvider } from '../modules/deploy-kit/tests/owner-provider.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';

// The deploy door with the real owner kit; only Cloudflare and the app's claim
// endpoint are fake. The hook says what it was given in its own output, as a
// seed's build and deploy hooks do. Values are random so a leak cannot match by chance.
async function checkout(t, { publicSettings = ['APP_HOST'] } = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'rer-deploy-redaction-')));
 const saved = { ...process.env };
 t.after(async () => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); await rm(root, { recursive: true, force: true }); });
 process.env.CI = 'true';
 for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SETUP_TOKEN', 'SESSION_SECRET', 'OWNER_EMAIL', 'MAIL_API_KEY', 'APP_HOST', 'MAIL_FROM', 'TEAM_REGION']) delete process.env[key];
 const provider = ownerProvider();
 t.after(() => provider.close());
 let claimed = false;
 t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
  const url = new URL(input);
  if (url.pathname === '/auth/bootstrap') {
   if (JSON.parse(init.body).token !== provider.state.secrets.find(item => item.name === 'SETUP_TOKEN')?.value) return Response.json({ error: 'invalid_setup_token' }, { status: 403 });
   if (claimed) return Response.json({ error: 'already_initialized' }, { status: 409 });
   claimed = true; return new Response(null, { status: 303, headers: { 'set-cookie': 'session=test; HttpOnly' } });
  }
  if (url.pathname === '/setup') return new Response(null, { status: 303, headers: { location: '/app' } });
  if (url.pathname === '/auth/signout') {
   assert.equal(new Headers(init.headers).get('cookie'), 'session=test');
   return new Response(null, { status: 204 });
  }
  return provider.fetch(input, init);
 });
 for (const directory of ['dist/server', 'dist/client', 'migrations/core']) await mkdir(join(root, directory), { recursive: true });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] }));
 await writeFile(join(root, 'dist/server/index.js'), 'export default { fetch(){return new Response("ok")} }');
 await writeFile(join(root, 'dist/client/index.html'), 'Application');
 await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.12.4' }));
 const declaration = { version: 1, project: 'tests/fixture', compatibilityDate: '2026-09-08', vars: { MAIL_PROVIDER: 'resend', MAIL_FROM: productionSender }, publicSettings,
  secrets: ['OWNER_EMAIL', 'SETUP_TOKEN', 'SESSION_SECRET', 'MAIL_API_KEY'].map(name => ({ binding: name, environment: name })) };
 await writeFile(join(root, 'deploy.json'), JSON.stringify(declaration));
 await writeFile(join(root, '.gitignore'), 'dist/\n.rer/\n.seed/\nowner.env\n');
 const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
 git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
 const values = { secret: randomBytes(16).toString('hex'), undeclared: `region-${randomBytes(6).toString('hex')}`, region: `eu-${randomBytes(6).toString('hex')}` };
 const writeEnv = extra => writeFile(join(root, 'owner.env'), Object.entries({ CLOUDFLARE_ACCOUNT_ID: provider.accountId, CLOUDFLARE_API_TOKEN: provider.token, OWNER_EMAIL: 'owner@example.test', MAIL_API_KEY: values.secret, ...extra }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
 const output = [];
 t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
 const adapter = { settings: [], run: async () => {}, deployDeclaration: 'deploy.json', hooks: { owner: {} } };
 adapter.deploy = async ({ options, store }) => {
  store.report(`hook sees mail key ${process.env.MAIL_API_KEY}, sender ${process.env.MAIL_FROM}, host ${process.env.APP_HOST}, region ${process.env.TEAM_REGION}`);
  return { deployed: true, ...(await ownerKit(['deploy', '--declaration', 'deploy.json', '--environment', options.environment ?? 'production'], process.env, { cwd: root })) };
 };
 const manifest = { steps: [{ type: 'owner-claim', mode: 'signed', path: '/auth/owner-claim', emailField: 'OWNER_EMAIL', tokenField: 'SETUP_TOKEN' }], fields: ['SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ name, kind: 'secret', generate: 'hex' })) };
 const run = async (options = {}) => {
  output.length = 0;
  const out = { progress: line => output.push(line), event: (event, details) => output.push(JSON.stringify({ event, ...details })), human: line => output.push(line) };
  const result = await runCommand({ root, profile: 'first-party', adapter, setupManifest: manifest }, { verb: 'deploy', forwarded: [], envFile: 'owner.env', ...options }, out);
  output.push(JSON.stringify(result));
  return result;
 };
 // Everything rer left on disk for the run (logs, records, state) except the person's own env file.
 const files = async () => {
  const found = [];
  for (const name of await readdir(root, { recursive: true })) {
   if (name.startsWith('.git/') || name === 'owner.env' || name === 'deploy.json') continue;
   try { found.push(await readFile(join(root, name), 'utf8')); } catch { /* a directory */ }
  }
  return found.join('\n');
 };
 return { root, git, provider, values, writeEnv, run, output, files, writeDeclaration: async changed => writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, ...changed })) };
}

test('rer deploy prints declared non-secret settings in full, so the sign-in address is usable, and never a secret or an undeclared value', async t => {
 const f = await checkout(t);
 await f.writeEnv({});
 const first = await f.run({ json: true }), host = new URL(first.origin).host;
 await f.writeEnv({ APP_HOST: host, MAIL_FROM: 'sender-' + host, TEAM_REGION: f.values.undeclared });
 for (const json of [false, true]) {
  await f.run({ json });
  const text = f.output.join('');
  assert.ok(text.includes(`Sign in by email at https://${host}.`), `the sign-in line names the host (json ${json})`);
  assert.ok(text.includes(`sender sender-${host}`), 'a declared var prints in full');
  assert.ok(text.includes(`host ${host}`), 'a declared public setting prints in full');
  assert.ok(!text.includes(f.values.secret), 'a declared secret never appears in output');
  assert.ok(!text.includes(f.values.undeclared), 'an undeclared value stays redacted');
  const notice = 'Undeclared --env-file settings stay out of rer\'s output: TEAM_REGION. To print one, declare it as a non-secret setting: add its name to "publicSettings" in deploy.json.';
  assert.ok(text.includes(json ? JSON.stringify(notice).slice(1, -1) : notice), 'the output says how to declare the undeclared setting');
  assert.ok(!/Undeclared --env-file settings[^.]*APP_HOST/.test(text), 'a declared setting is not listed as undeclared');
 }
 const left = await f.files();
 assert.ok(!left.includes(f.values.secret) && !left.includes(f.values.undeclared), 'logs and records hold no secret or undeclared value');
});

test('declaring an --env-file setting as non-secret prints it; a declared secret or credential-named key cannot be made public', async t => {
 const f = await checkout(t, { publicSettings: ['APP_HOST', 'TEAM_REGION', 'MAIL_API_KEY'] });
 await f.writeEnv({});
 const first = await f.run({ json: true }), host = new URL(first.origin).host;
 await f.writeEnv({ APP_HOST: host, TEAM_REGION: f.values.region });
 await f.run({});
 const text = f.output.join('');
 assert.ok(text.includes(`region ${f.values.region}`), 'a setting the declaration names public prints in full');
 assert.ok(!text.includes(f.values.secret), 'a declared secret stays redacted even when also listed as public');
 assert.doesNotMatch(text, /Undeclared --env-file settings/);
 await f.writeDeclaration({ publicSettings: ['lowercase'] });
 f.git('commit', '-qam', 'invalid public setting');
 await assert.rejects(f.run({}), /invalid-public-settings/);
});
