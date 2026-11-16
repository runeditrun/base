import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';
import { productionSender } from './fixtures/production-sender.mjs';

// The public command and actual deploy kit; only the provider network edge is fake.
test('rer deploy protects environment provider credentials from every provider-prefixed env-file key', async t => {
 const runtimeValue = 'synthetic-base-runtime-1';
 const { root, provider, run: deploy } = await deployProviderFixture(t, {
  vars: { MAIL_PROVIDER: 'resend', MAIL_FROM: productionSender, MAIL_API_KEY: 'synthetic-base-mail-1' },
  secrets: [{ binding: 'RUNTIME_SECRET', environment: 'RUNTIME_SECRET' }],
 });
 let output = '';
 t.mock.method(process.stdout, 'write', chunk => { output += String(chunk); return true; });
 t.mock.method(process.stderr, 'write', chunk => { output += String(chunk); return true; });
 let requests = 0;
 t.mock.method(globalThis, 'fetch', (...args) => { requests++; return provider.fetch(...args); });
 const run = async (contents, ...flags) => {
  await writeFile(join(root, 'deploy.env'), contents, { mode: 0o600 });
  output = '';
  const code = await deploy('--env-file', 'deploy.env', ...flags);
  return { code, output };
 };
 const providerInputs = {
  CLOUDFLARE_API_TOKEN: provider.token,
  CF_API_TOKEN: 'synthetic-base-alias-1',
  CLOUDFLARE_ACCOUNT_ID: provider.accountId,
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-base-email-token-1',
  CLOUDFLARE_EMAIL_ACCOUNT_ID: 'synthetic-base-email-account-1',
  CF_THROWAWAY_API_TOKEN: 'synthetic-base-stage-token-1',
  CF_THROWAWAY_ACCOUNT_ID: 'synthetic-base-stage-account-1',
  CLOUDFLARE_API_BASE_URL: 'https://synthetic-base-1.test',
  CLOUDFLARE_UNDECLARED: '',
  CF_UNDECLARED: 'synthetic-base-unknown-1',
 };
 for (const [key, value] of Object.entries(providerInputs)) {
  const result = await run(`RUNTIME_SECRET=${runtimeValue}\n${key}=${value}\n`);
  assert.equal(result.code, 4, result.output);
  const error = result.output.trim().split('\n').map(JSON.parse).find(event => event.event === 'error');
  assert.equal(error.code, 'safety_refusal');
  assert.ok(error.message.includes('deploy.env') && error.message.includes(key), result.output);
  for (const secret of [value, runtimeValue, provider.token].filter(Boolean)) assert.ok(!result.output.includes(secret), 'no input value reaches diagnostics');
  assert.equal(requests, 0, `${key} is refused before any network request`);
  assert.equal(provider.state.calls.length, 0);
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, provider.token, 'the caller token is kept');
 }
 const dry = await run(`CF_API_TOKEN=${providerInputs.CF_API_TOKEN}\n`, '--dry-run');
 assert.equal(dry.code, 4, dry.output);
 assert.equal(requests, 0, 'dry runs enforce the same input guard');

 const runtime = await run(`RUNTIME_SECRET=${runtimeValue}\n`);
 assert.equal(runtime.code, 0, runtime.output);
 assert.ok(requests > 0, 'a runtime-only file still reaches the provider');
 assert.equal(provider.state.secrets.find(item => item.name === 'RUNTIME_SECRET')?.value, runtimeValue);

 // File-only credentials remain supported, including repeated reads after the
 // lifecycle has installed the file's token into process.env for the adapter.
 const fileCredentials = Object.entries({ ...providerInputs, RUNTIME_SECRET: runtimeValue }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
 for (const token of [undefined, '', ' \t ']) {
  if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = token;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  const before = requests;
  const result = await run(fileCredentials);
  assert.equal(result.code, 0, result.output);
  assert.ok(requests > before, 'file-only credentials reach the actual provider fixture');
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, token, 'the original token state is restored');
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.ok(!result.output.includes(provider.token), 'file-only credentials stay private');
 }
});
