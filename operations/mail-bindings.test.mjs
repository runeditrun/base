import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeOperations, inspectOperations } from './operations.mjs';

const binding = () => ({
  providerEnvironment: 'MAIL_PROVIDER',
  providers: {
    sendgrid: { apiKeyEnvironment: 'MAIL_API_KEY', requiredEnvironment: ['MAIL_FROM'] },
    resend: { apiKeyEnvironment: 'MAIL_API_KEY', requiredEnvironment: ['MAIL_FROM'] },
    development: { requiredEnvironment: ['MAIL_FROM'], development: { modeEnvironment: 'ENVIRONMENT', originEnvironment: 'APP_URL' } }
  },
  whenUnset: { provider: 'resend', apiKeyEnvironment: 'RESEND_API_KEY', requiredEnvironment: ['RESEND_FROM_EMAIL'] }
});

async function fixture(t, selected = binding()) {
  const root = await mkdtemp(join(tmpdir(), 'operations-mail-bindings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const name of ['operations.mjs', 'project-operations.mjs']) await copyFile(new URL(name, import.meta.url), join(root, 'scripts', name));
  await writeFile(join(root, 'verify.mjs'), 'throw new Error("Inspection executed a command");');
  await writeFile(join(root, 'config.mjs'), 'export function validateConfiguration(env) { if (env.VALIDATION_SENTINEL) throw new Error(env.VALIDATION_SENTINEL); }');
  await writeFile(join(root, 'SETUP.md'), 'Read-only local input inspection');
  const descriptor = {
    version: 2, project: 'independent/mail-project', runtime: { requirements: [] }, requiredEnvironment: [],
    documentation: { document: 'SETUP.md' }, configuration: { module: 'config.mjs' },
    commands: { verify: { argv: ['node', 'verify.mjs'], inputs: ['verify.mjs'], effects: 'Local validation' } },
    loops: [{ id: 'sign-in', type: 'mail', required: true, enabled: true, binding: selected }]
  };
  const save = () => writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  await save();
  const run = (env = {}, command = 'check') => spawnSync(process.execPath, ['scripts/operations.mjs', command], { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 5000 });
  return { root, descriptor, save, run };
}

test('mail binding checks the selected runtime inputs, preserves foundation validation, and guides the CLI without values', async t => {
  const { root, descriptor, save, run } = await fixture(t);
  descriptor.environmentSources = { MAIL_API_KEY: 'Owner vault, active mail account', RESEND_API_KEY: 'Owner vault, legacy mail account' };
  await save();
  await describeOperations(root);
  const foundation = await inspectOperations(root, {});
  assert.equal(foundation.configuration, 'valid');
  assert.equal(foundation.ok, false);
  assert.deepEqual(foundation.loops[0].missingEnvironment, ['RESEND_API_KEY', 'RESEND_FROM_EMAIL']);
  for (const provider of ['sendgrid', 'resend']) {
    const selected = { MAIL_PROVIDER: provider, MAIL_FROM: 'noreply@example.test' };
    for (const inactive of [{}, { RESEND_API_KEY: 'synthetic-inactive', RESEND_FROM_EMAIL: 'noreply@legacy.example.test' }, { SENDGRID_API_KEY: 'synthetic-inactive' }]) {
      const report = await inspectOperations(root, { ...selected, ...inactive });
      assert.equal(report.ok, false);
      assert.deepEqual(report.loops[0].missingEnvironment, ['MAIL_API_KEY']);
    }
    const env = { ...selected, MAIL_API_KEY: 'synthetic-active' };
    assert.equal((await inspectOperations(root, env)).ok, true);
    assert.equal((await inspectOperations(root, { ...env, MAIL_FROM: ' ' })).ok, false);
  }
  const legacy = { RESEND_API_KEY: 'synthetic-legacy', RESEND_FROM_EMAIL: 'noreply@legacy.example.test' };
  assert.equal((await inspectOperations(root, legacy)).ok, true);
  assert.equal((await inspectOperations(root, { MAIL_API_KEY: 'synthetic-active', MAIL_FROM: 'noreply@example.test' })).ok, false);
  for (const provider of ['', ' ', 'unknown-synthetic-selector', 'RESEND', null, false, 1, [], {}, 'toString', '__proto__']) {
    const report = await inspectOperations(root, { ...legacy, MAIL_PROVIDER: provider });
    assert.equal(report.ok, false);
    assert.equal(report.loops[0].status, 'invalid-mail-provider');
    assert.deepEqual(report.loops[0].missingEnvironment, ['MAIL_PROVIDER']);
  }
  const checked = run({ MAIL_PROVIDER: 'sendgrid', MAIL_FROM: 'noreply@example.test', RESEND_API_KEY: 'synthetic-inactive' });
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).loops[0].missingEnvironment, ['MAIL_API_KEY']);
  assert.ok(checked.stderr.includes(descriptor.environmentSources.MAIL_API_KEY));
  assert.equal(checked.stderr.includes(descriptor.environmentSources.RESEND_API_KEY), false);
  assert.equal(`${checked.stdout}${checked.stderr}`.includes('synthetic-inactive'), false);
  const valid = run(legacy);
  assert.equal(valid.status, 0);
  assert.ok(JSON.parse(valid.stdout).unchecked.includes('provider credentials and delivery'));
  const invalid = run({ ...legacy, VALIDATION_SENTINEL: 'synthetic-validator-private-value' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).configuration, 'invalid');
  assert.equal(`${invalid.stdout}${invalid.stderr}`.includes('synthetic-validator-private-value'), false);
  for (const name of ['MAIL_API_KEY', 'MAIL_FROM', 'RESEND_FROM_EMAIL', 'APP_URL']) assert.ok(invalid.stderr.includes(name));
});

test('development mail is explicit and confined to canonical loopback origins in development mode', async t => {
  const { root, descriptor, save } = await fixture(t);
  const local = { MAIL_PROVIDER: 'development', ENVIRONMENT: 'development', MAIL_FROM: 'noreply@example.test' };
  for (const origin of ['http://localhost', 'https://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787/']) {
    assert.equal((await inspectOperations(root, { ...local, APP_URL: origin })).ok, true);
    assert.equal((await inspectOperations(root, { ...local, APP_URL: origin, MAIL_API_KEY: 'unused-synthetic-value' })).ok, true);
  }
  for (const origin of [undefined, '', 'https://remote.example.test', 'http://localhost.remote.example.test', 'http://127.0.0.2', 'http://127.1', 'http://2130706433', 'http://localhost.', 'http://LOCALHOST', 'http://localhost/a', 'http://localhost/..', 'http://localhost?x', 'http://localhost?', 'http://localhost#', 'http://user:synthetic-private@localhost', 'ftp://localhost', ' http://localhost', 'http://[::ffff:127.0.0.1]', false]) {
    const report = await inspectOperations(root, { ...local, APP_URL: origin });
    assert.equal(report.ok, false);
    assert.ok(report.loops[0].missingEnvironment.includes('APP_URL'));
    assert.equal(JSON.stringify(report).includes('synthetic-private'), false);
  }
  for (const mode of [undefined, '', 'preview', 'production', 'Development', true]) {
    const report = await inspectOperations(root, { ...local, ENVIRONMENT: mode, APP_URL: 'http://localhost:8787' });
    assert.equal(report.ok, false);
    assert.ok(report.loops[0].missingEnvironment.includes('ENVIRONMENT'));
  }
  assert.equal((await inspectOperations(root, { ENVIRONMENT: 'development', APP_URL: 'http://localhost', MAIL_FROM: 'noreply@example.test' })).ok, false);
  descriptor.loops[0].enabled = false;
  await save();
  assert.equal((await inspectOperations(root, local)).loops[0].status, 'disabled-required');
  descriptor.loops[0].required = false;
  await save();
  assert.equal((await inspectOperations(root, {})).ok, true);
});

test('another project binds its own selector, hosted credentials, sender, account and development guard names', async t => {
  const alternate = {
    providerEnvironment: 'DELIVERY_DRIVER',
    providers: {
      cloudflare: { apiKeyEnvironment: 'DELIVERY_TOKEN', accountIdEnvironment: 'DELIVERY_ACCOUNT', requiredEnvironment: ['SENDER_ADDRESS'] },
      development: { requiredEnvironment: ['SENDER_ADDRESS'], development: { modeEnvironment: 'RUN_MODE', originEnvironment: 'SITE_ORIGIN' } }
    }
  };
  const { root, descriptor, save, run } = await fixture(t, alternate);
  descriptor.environmentSources = Object.fromEntries(['DELIVERY_DRIVER', 'DELIVERY_TOKEN', 'DELIVERY_ACCOUNT', 'SENDER_ADDRESS', 'RUN_MODE', 'SITE_ORIGIN'].map(name => [name, 'Project setup guide, delivery section']));
  await save();
  await describeOperations(root);
  const hosted = { DELIVERY_DRIVER: 'cloudflare', DELIVERY_TOKEN: 'synthetic-token', DELIVERY_ACCOUNT: 'a'.repeat(32), SENDER_ADDRESS: 'noreply@example.test' };
  assert.equal(run(hosted).status, 0);
  for (const account of ['', 'a'.repeat(31), 'g'.repeat(32), 123]) {
    const result = await inspectOperations(root, { ...hosted, DELIVERY_ACCOUNT: account });
    assert.equal(result.ok, false);
    assert.deepEqual(result.loops[0].missingEnvironment, ['DELIVERY_ACCOUNT']);
  }
  const missing = run({ DELIVERY_DRIVER: 'cloudflare', CLOUDFLARE_EMAIL_API_TOKEN: 'wrong-synthetic-token', CLOUDFLARE_EMAIL_ACCOUNT_ID: 'a'.repeat(32), SENDER_ADDRESS: hosted.SENDER_ADDRESS });
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout).loops[0].missingEnvironment, ['DELIVERY_TOKEN', 'DELIVERY_ACCOUNT']);
  assert.ok(missing.stderr.includes(descriptor.environmentSources.DELIVERY_TOKEN));
  assert.equal(run({ DELIVERY_DRIVER: 'development', RUN_MODE: 'development', SITE_ORIGIN: 'http://[::1]:8787', SENDER_ADDRESS: hosted.SENDER_ADDRESS }).status, 0);
  assert.equal((await inspectOperations(root, { ...hosted, DELIVERY_DRIVER: undefined })).ok, false);
  descriptor.environmentSources.MAIL_API_KEY = 'Undeclared input source';
  await save();
  await assert.rejects(describeOperations(root));
});

test('malformed bindings fail describe and check even while disabled and never disclose malformed values', async t => {
  const { root, descriptor, save, run } = await fixture(t);
  const pristine = structuredClone(descriptor.loops[0]);
  const mutations = [
    loop => { loop.provider = 'resend'; },
    loop => { delete loop.binding; loop.provider = 'unknown'; },
    loop => { delete loop.binding; loop.provider = null; },
    loop => { delete loop.binding; },
    loop => { loop.type = 'worker'; },
    loop => { loop.required = 'false'; },
    loop => { loop.binding = null; },
    loop => { loop.binding.extra = 'synthetic-private-value'; },
    loop => { loop.binding.providerEnvironment = 'private-lowercase'; },
    loop => { loop.binding.providerEnvironment = 1; },
    loop => { loop.binding.providerEnvironment = 'MAIL_PROVIDER\n'; },
    loop => { loop.binding.providers = []; },
    loop => { loop.binding.providers = {}; },
    loop => { loop.binding.providers.unknown = loop.binding.providers.resend; },
    loop => { loop.binding.providers.resend.extra = 'synthetic-private-value'; },
    loop => { delete loop.binding.providers.resend.apiKeyEnvironment; },
    loop => { loop.binding.providers.resend.apiKeyEnvironment = 'invalid-name'; },
    loop => { loop.binding.providers.resend.requiredEnvironment = 'MAIL_FROM'; },
    loop => { loop.binding.providers.resend.requiredEnvironment = [null]; },
    loop => { loop.binding.providers.resend.accountIdEnvironment = 'ACCOUNT'; },
    loop => { loop.binding.providers.cloudflare = { apiKeyEnvironment: 'KEY', requiredEnvironment: [] }; },
    loop => { loop.binding.providers.development.apiKeyEnvironment = 'KEY'; },
    loop => { loop.binding.providers.development.development = {}; },
    loop => { loop.binding.providers.development.development.modeEnvironment = 'bad-mode'; },
    loop => { loop.binding.providers.development.development.originEnvironment = false; },
    loop => { loop.binding.providers.development.development.extra = 'synthetic-private-value'; },
    loop => { loop.binding.providers.resend.development = { modeEnvironment: 'ENVIRONMENT', originEnvironment: 'APP_URL' }; },
    loop => { loop.binding.whenUnset = null; },
    loop => { loop.binding.whenUnset = { provider: 'development', requiredEnvironment: [], development: { modeEnvironment: 'ENVIRONMENT', originEnvironment: 'APP_URL' } }; },
    loop => { loop.binding.whenUnset.provider = 'unknown'; },
    loop => { loop.binding.whenUnset.apiKeyEnvironment = false; },
    loop => { loop.binding.whenUnset.extra = 'synthetic-private-value'; },
    loop => { loop.extra = 'synthetic-private-value'; }
  ];
  for (const mutate of mutations) {
    descriptor.loops[0] = structuredClone(pristine);
    descriptor.loops[0].enabled = false;
    descriptor.loops[0].required = false;
    mutate(descriptor.loops[0]);
    await save();
    await assert.rejects(describeOperations(root));
    await assert.rejects(inspectOperations(root, {}));
  }
  for (const command of ['describe', 'check']) {
    const result = run({}, command);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('synthetic-private-value'), false);
  }
  for (const loops of [null, {}, 'invalid', [null], [pristine, pristine]]) {
    descriptor.loops = loops;
    await save();
    await assert.rejects(describeOperations(root));
    await assert.rejects(inspectOperations(root, {}));
  }
});

test('fixed hosted declarations retain credential selection, Cloudflare validation and mismatch behavior', async t => {
  const { root, descriptor, save } = await fixture(t);
  delete descriptor.loops[0].binding;
  for (const [provider, key, account] of [
    ['sendgrid', 'SENDGRID_API_KEY'], ['resend', 'RESEND_API_KEY'], ['cloudflare', 'CLOUDFLARE_EMAIL_API_TOKEN', 'CLOUDFLARE_EMAIL_ACCOUNT_ID']
  ]) {
    descriptor.loops[0].provider = provider;
    await save();
    const env = { [key]: 'synthetic-active', ...(account ? { [account]: 'a'.repeat(32) } : {}) };
    for (const selector of [undefined, '', provider]) assert.equal((await inspectOperations(root, { ...env, MAIL_PROVIDER: selector })).ok, true);
    assert.equal((await inspectOperations(root, { MAIL_API_KEY: 'wrong-synthetic-value' })).ok, false);
    assert.equal((await inspectOperations(root, { ...env, [key]: ' ' })).ok, false);
    assert.equal((await inspectOperations(root, { ...env, MAIL_PROVIDER: 'other' })).loops[0].status, 'mail-provider-mismatch');
    if (account) assert.equal((await inspectOperations(root, { ...env, [account]: 'invalid' })).ok, false);
  }
});
