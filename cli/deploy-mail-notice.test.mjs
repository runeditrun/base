import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCommand } from './lifecycle.mjs';
import { ownerDeploy } from './deploy.mjs';
import { main as ownerKit } from '../modules/deploy-kit/owner-cli.mjs';
import { productionSender } from './fixtures/production-sender.mjs';
import { manifest, checkout, account, lifecycle } from './fixtures/owner-deploy.mjs';

// The deploy door against the fake Cloudflare account: a seed whose mail is off by
// MAIL_PROVIDER=none, with mail credentials set later through --set-secret. Only the
// provider and the hosted app's claim endpoint are fake. The values are shaped like
// HappyToHelp's: one equals another secret's NAME and one is the word inside other names.
const mailNames = ['EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_API_KEY_NAME', 'MAILGUN_DOMAIN', 'MAILGUN_REGION', 'MAILGUN_SENDING_KEY', 'MAILGUN_WEBHOOK_SIGNING_KEY'];
const signIn = 'node scripts/signin.mjs';
const offLine = /Outbound email is off \(MAIL_PROVIDER=none\)/;

async function fixture(t, { declareMail = true, route }) {
 const secrets = [...['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN'].map(name => ({ binding: name, environment: name })), ...mailNames.map(name => ({ binding: name, environment: name, optional: true }))];
 const { root, git } = await checkout(t, { secrets, vars: { MAIL_PROVIDER: 'none', MAIL_FROM: productionSender } });
 await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.12.4' }));
 if (declareMail) {
  await mkdir(join(root, 'management/integration'), { recursive: true });
  await writeFile(join(root, 'management/integration/deployment-spec.json'), JSON.stringify({ secretNames: [], optionalSecretNames: mailNames, mail: { providers: ['rer'], credentialSecretNames: mailNames } }));
 }
 git('add', '.'); git('commit', '-qm', 'declare the mail secret names');
 const { provider } = account(t);
 const ci = process.env.CI; process.env.CI = 'true';
 t.after(() => { if (ci === undefined) delete process.env.CI; else process.env.CI = ci; });
 const values = { EMAIL_PROVIDER: 'mailgun', EMAIL_FROM: 'sender@example.test', EMAIL_API_KEY_NAME: 'MAILGUN_SENDING_KEY', MAILGUN_DOMAIN: 'mg.example.test', MAILGUN_REGION: 'eu', MAILGUN_SENDING_KEY: `key-${randomBytes(12).toString('hex')}`, MAILGUN_WEBHOOK_SIGNING_KEY: randomBytes(16).toString('hex') };
 await writeFile(join(root, 'mail-on.env'), Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 });
 await writeFile(join(root, 'owner.env'), 'OWNER_EMAIL=owner@example.test\n', { mode: 0o600 });
 const adapter = { settings: [], run: async () => {}, deployDeclaration: 'deploy.json', hooks: lifecycle.hooks, mailOffSignIn: signIn };
 // A native owner deploy, or a hook that deploys through the kit and reports what it was given.
 adapter.deploy = route === 'native' ? ownerDeploy('deploy.json', adapter)
  : async ({ options, store }) => {
   store.report(`hook sees key ${process.env.MAILGUN_SENDING_KEY ?? 'none'}, provider ${process.env.EMAIL_PROVIDER ?? 'none'}`);
   return { deployed: true, ...(await ownerKit(['deploy', '--declaration', 'deploy.json', '--environment', options.environment ?? 'production'], process.env, { cwd: root })) };
  };
 const output = [];
 const run = async (options = {}) => {
  output.length = 0;
  const out = { progress: line => output.push(line), event: (event, details) => output.push(JSON.stringify({ event, ...details })), human: line => output.push(line) };
  await runCommand({ root, profile: 'first-party', adapter, setupManifest: manifest }, { verb: 'deploy', forwarded: [], envFile: 'owner.env', ...options }, out);
  return output.join('');
 };
 return { root, git, provider, values, run };
}

for (const route of ['native', 'hook']) {
 test(`rer deploy (${route} route) says mail is off only while no declared mail secret is bound, and set-secret lines keep secret names intact`, async t => {
  const f = await fixture(t, { route });
  // Nothing bound yet: the off line is true.
  assert.match(await f.run(), offLine);
  // The seven mail secrets, set later: confirmation lists every name whole, and no value.
  const set = await f.run({ envFile: 'mail-on.env', setSecret: mailNames.join(',') });
  assert.ok(set.includes(`Set ${mailNames.join(', ')} on this environment's Worker`), set);
  assert.ok(!set.includes(f.values.MAILGUN_SENDING_KEY) && !set.includes(f.values.MAILGUN_WEBHOOK_SIGNING_KEY));
  assert.deepEqual(f.provider.state.secrets.map(item => item.name).filter(name => mailNames.includes(name)).sort(), [...mailNames].sort());
  // A plain redeploy no longer claims that no mail credential is bound.
  f.git('commit', '--allow-empty', '-qm', 'redeploy');
  const again = await f.run();
  assert.doesNotMatch(again, offLine);
  assert.ok(again.includes(`Outbound email is configured by the secrets bound on this environment's Worker: ${mailNames.join(', ')}`), again);
  assert.ok(!again.includes(f.values.MAILGUN_SENDING_KEY) && !again.includes(f.values.MAILGUN_WEBHOOK_SIGNING_KEY));
  // Removing every one of them makes the off line true again; a partial removal keeps naming what is left.
  const removed = await f.run({ unsetSecret: mailNames.slice(0, 6).join(',') });
  assert.ok(removed.includes(`Removed ${mailNames.slice(0, 6).join(', ')} on this environment's Worker`), removed);
  f.git('commit', '--allow-empty', '-qm', 'redeploy again');
  assert.ok((await f.run()).includes(`bound on this environment's Worker: MAILGUN_WEBHOOK_SIGNING_KEY (names only`));
  await f.run({ unsetSecret: 'MAILGUN_WEBHOOK_SIGNING_KEY' });
  f.git('commit', '--allow-empty', '-qm', 'redeploy last');
  assert.match(await f.run(), offLine);
 });
}

test('a value that appears inside other text is still redacted, while the names around it are not', async t => {
 const f = await fixture(t, { route: 'hook' });
 await f.run();
 const set = await f.run({ envFile: 'mail-on.env', setSecret: mailNames.join(',') });
 assert.ok(!set.includes(f.values.MAILGUN_SENDING_KEY) && !set.includes(f.values.MAILGUN_WEBHOOK_SIGNING_KEY));
 f.git('commit', '--allow-empty', '-qm', 'redeploy');
 const text = await f.run({ envFile: 'mail-on.env' });
 assert.ok(!text.includes(f.values.MAILGUN_SENDING_KEY), 'the hook printed the key; it stays redacted');
 assert.match(text, /hook sees key \[REDACTED\], provider \[REDACTED\]/, 'a value equal to part of a name is still redacted in other text');
});

test('a seed that declares no mail credential names keeps today\'s off line even with mail secrets bound', async t => {
 const f = await fixture(t, { route: 'native', declareMail: false });
 await f.run();
 await f.run({ envFile: 'mail-on.env', setSecret: mailNames.join(',') });
 f.git('commit', '--allow-empty', '-qm', 'redeploy');
 assert.match(await f.run(), offLine);
});

test('a dry run says it did not read the bound secrets instead of claiming no mail credential is bound', async t => {
 const f = await fixture(t, { route: 'native' });
 const dry = await f.run({ dryRun: true });
 assert.match(dry, offLine);
 assert.ok(dry.includes(`The bound secrets were not read: if one of ${mailNames.join(', ')} is bound on the Worker, outbound email is configured by it.`), dry);
});

test('mail.credentialSecretNames must name secrets the deployment declares, without duplicates', async t => {
 const f = await fixture(t, { route: 'native' });
 const declare = async mail => {
  await writeFile(join(f.root, 'management/integration/deployment-spec.json'), JSON.stringify({ secretNames: [], optionalSecretNames: mailNames, mail }));
  f.git('commit', '-qam', 'change the mail declaration');
 };
 await declare({ providers: ['rer'], credentialSecretNames: [...mailNames, 'NOT_DECLARED'] });
 await assert.rejects(f.run(), /credentialSecretNames[^]*NOT_DECLARED/);
 await declare({ providers: ['rer'], credentialSecretNames: ['EMAIL_FROM', 'EMAIL_FROM'] });
 await assert.rejects(f.run(), /Duplicate/);
 await declare({ providers: ['rer'], credentialSecretNames: 'EMAIL_FROM' });
 await assert.rejects(f.run(), /credentialSecretNames/);
});
