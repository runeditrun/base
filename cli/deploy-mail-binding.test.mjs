import { productionSender } from './fixtures/production-sender.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deployProviderFixture } from './fixtures/deploy-provider.mjs';
import { main } from './main.mjs';

// Run the public deploy command; only the existing Cloudflare network edge is fake.
test('rer deploy accepts the declared adapter mail credential and preserves its environment mapping', async t => {
 for (const providerName of ['sendgrid', 'resend']) await t.test(providerName, async t => {
  const binding = 'MAIL_PROVIDER_API_KEY', value = 'test-only-adapter-mail-credential';
  const { root, provider, run: deploy } = await deployProviderFixture(t, {
   vars: { MAIL_PROVIDER: providerName, MAIL_FROM: productionSender },
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

test('public deploy dry-run refuses placeholder senders before provider access and accepts their correction', async t => {
 const { root, provider } = await deployProviderFixture(t, {
  vars: { MAIL_PROVIDER: 'resend', MAIL_FROM: productionSender, MAIL_API_KEY: 'synthetic-mail-1' },
 });
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 let stdout = '', stderr = '';
 t.mock.method(process.stdout, 'write', chunk => { stdout += String(chunk); return true; });
 t.mock.method(process.stderr, 'write', chunk => { stderr += String(chunk); return true; });
 const run = async (json, ...flags) => {
  stdout = ''; stderr = '';
  const code = await main(['deploy', '--dry-run', '--cwd', root, ...(json ? ['--json'] : []), ...flags]);
  return { code, text: stdout + stderr };
 };
 for (const sender of ['Your Business <sender@example.invalid>', 'sender@example.com', productionSender.replace(/@.+/, '@yourdomain.com'), productionSender.replace(/^[^@]+/, 'fake'), 'sender@example.test', 'not-an-address']) {
  await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars: { ...declaration.vars, MAIL_FROM: sender } }));
  for (const json of [false, true]) {
   const before = provider.state.calls.length, result = await run(json);
   assert.equal(result.code, 4, result.text);
   assert.ok(result.text.includes('MAIL_FROM') && result.text.includes('vars'), 'the refusal names the setting and its declaration location');
   assert.equal(provider.state.calls.length, before, 'placeholder refusal precedes provider access');
  }
 }
 const { MAIL_FROM, ...vars } = declaration.vars;
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars }));
 await writeFile(join(root, 'rer-packaging.json'), JSON.stringify({ artifact: { specInputs: { publicVariables: { MAIL_FROM: 'sender@example.invalid' } } } }));
 const packaged = await run(true);
 assert.equal(packaged.code, 4, packaged.text);
 assert.ok(packaged.text.includes('rer-packaging.json') && packaged.text.includes('publicVariables.MAIL_FROM'), 'the correction identifies the packaging source');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars, secrets: [{ binding: 'MAIL_FROM', environment: 'OUTBOUND_SENDER' }] }));
 await writeFile(join(root, 'sender.env'), 'OUTBOUND_SENDER=sender@example.invalid\n', { mode: 0o600 });
 const mapped = await run(true, '--env-file', 'sender.env');
 assert.equal(mapped.code, 4, mapped.text);
 assert.ok(mapped.text.includes('OUTBOUND_SENDER') && mapped.text.includes('--env-file'), 'the correction follows the declared environment mapping');
 await writeFile(join(root, 'sender.env'), `OUTBOUND_SENDER=${MAIL_FROM}\n`, { mode: 0o600 });
 const corrected = await run(true, '--env-file', 'sender.env');
 assert.equal(corrected.code, 0, corrected.text);
 assert.equal(provider.state.writes.length, 0, 'neither refusal nor corrected dry-run writes to the provider');
});
