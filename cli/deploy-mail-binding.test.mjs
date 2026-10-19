import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';

// Run the public deploy command; only the existing Cloudflare network edge is fake.
test('rer deploy accepts the declared adapter mail credential and preserves its environment mapping', async t => {
 for (const providerName of ['sendgrid', 'resend']) await t.test(providerName, async t => {
  const binding = 'MAIL_PROVIDER_API_KEY', value = 'test-only-adapter-mail-credential';
  const { root, provider, run: deploy } = await deployProviderFixture(t, {
   vars: { MAIL_PROVIDER: providerName, MAIL_FROM: 'sender@example.test' },
   secrets: [{ binding, environment: 'SEED_MAIL_TOKEN', optional: true }],
  });
  const output = [];
  t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  const run = async values => {
   await writeFile(join(root, 'deploy.env'), values, { mode: 0o600 });
   output.length = 0;
   const code = await deploy('--env-file', 'deploy.env');
   return { code, text: output.join('') };
  };
  const missing = await run('');
  assert.equal(missing.code, 4, missing.text);
  assert.match(missing.text, /Production sign-in is not configured/);
  assert.equal(provider.state.writes.length, 0);
  const unmapped = await run(`${binding}=${value}\n`);
  assert.equal(unmapped.code, 4, unmapped.text);
  assert.equal(provider.state.writes.length, 0, 'the binding name cannot bypass its explicit environment mapping');
  const supplied = await run(`SEED_MAIL_TOKEN=${value}\n`);
  assert.equal(supplied.code, 0, supplied.text);
  assert.ok(missing.text.includes(binding), 'missing guidance names the adapter binding');
  assert.equal(provider.state.secrets.find(item => item.name === binding)?.value, value);
  assert.ok(provider.state.settings, 'the same command published the Worker');
  assert.ok(!supplied.text.includes(value), 'the credential stays private');
  const writes = provider.state.writes.length;
  const live = await run('');
  assert.equal(live.code, 0, live.text);
  assert.equal(provider.state.writes.length, writes, 'the declared live credential satisfies an unchanged redeploy');
 });
});
