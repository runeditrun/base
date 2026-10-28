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

test('public deploy dry-run accepts reserved fixture senders while real deploy preserves sender refusals', async t => {
 const { root, provider } = await deployProviderFixture(t, {
  vars: { MAIL_PROVIDER: 'resend', MAIL_FROM: productionSender, MAIL_API_KEY: 'synthetic-base-1' },
 });
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 for (const name of Object.keys(process.env)) if (/^(CLOUDFLARE_|CF_)/.test(name)) delete process.env[name];
 t.mock.method(globalThis, 'fetch', () => { throw Error('No network is available during local validation'); });
 let stdout = '', stderr = '';
 t.mock.method(process.stdout, 'write', chunk => { stdout += String(chunk); return true; });
 t.mock.method(process.stderr, 'write', chunk => { stderr += String(chunk); return true; });
 const run = async (json, dryRun, ...flags) => {
  stdout = ''; stderr = '';
  const code = await main(['deploy', '--non-interactive', ...(dryRun ? ['--dry-run'] : []), '--cwd', root, ...(json ? ['--json'] : []), ...flags]);
  return { code, text: stdout + stderr };
 };
 const fixtures = ['Support <support@dry-run.example.test>', 'sender@example.invalid', 'sender@example.com', 'sender@nested.example.net', 'sender@example.org', 'sender@fixture.example', 'sender@fixture.localhost', 'sender@fixture.test'];
 const placeholders = [productionSender.replace(/@.+/, '@yourdomain.com'), productionSender.replace(/^[^@]+/, 'fake'), 'not-an-address', 'Support <not-an-address>', 'sender@example.test,other@example.test'];
 for (const sender of [...fixtures, ...placeholders]) {
  await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars: { ...declaration.vars, MAIL_FROM: sender } }));
  for (const json of [false, true]) {
   const dry = await run(json, true), real = await run(json, false);
   assert.equal(dry.code, fixtures.includes(sender) ? 0 : 4, dry.text);
   assert.equal(real.code, 4, real.text);
   assert.ok(real.text.includes('MAIL_FROM') && real.text.includes('vars'), 'the refusal names the setting and its declaration location');
   if (fixtures.includes(sender)) {
    assert.match(dry.text, /Would deploy:/);
    assert.match(dry.text, /Needed for a real deploy/);
   }
   if (json) assert.match(real.text, /"code":"safety_refusal"/);
   assert.equal(provider.state.calls.length, 0, 'both local plans and sender refusals precede provider access');
   if (sender === fixtures[0]) t.diagnostic(`${json ? 'JSON' : 'Human'} fixture dry run: exit ${dry.code}; ${dry.text}Real deploy: exit ${real.code}; ${real.text}`);
  }
 }
 const { MAIL_FROM, ...vars } = declaration.vars;
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars }));
 await writeFile(join(root, 'rer-packaging.json'), JSON.stringify({ artifact: { specInputs: { publicVariables: { MAIL_FROM: 'sender@example.invalid' } } } }));
 const packagedDry = await run(true, true), packaged = await run(true, false);
 assert.equal(packagedDry.code, 0, packagedDry.text);
 assert.equal(packaged.code, 4, packaged.text);
 assert.ok(packaged.text.includes('rer-packaging.json') && packaged.text.includes('publicVariables.MAIL_FROM'), 'the correction identifies the packaging source');
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars, secrets: [{ binding: 'MAIL_FROM', environment: 'OUTBOUND_SENDER' }] }));
 await writeFile(join(root, 'sender.env'), 'OUTBOUND_SENDER=sender@example.invalid\n', { mode: 0o600 });
 const mappedDry = await run(true, true, '--env-file', 'sender.env'), mapped = await run(true, false, '--env-file', 'sender.env');
 assert.equal(mappedDry.code, 0, mappedDry.text);
 assert.equal(mapped.code, 4, mapped.text);
 assert.ok(mapped.text.includes('OUTBOUND_SENDER') && mapped.text.includes('--env-file'), 'the correction follows the declared environment mapping');
 await writeFile(join(root, 'sender.env'), `OUTBOUND_SENDER=${MAIL_FROM}\n`, { mode: 0o600 });
 const corrected = await run(true, true, '--env-file', 'sender.env');
 assert.equal(corrected.code, 0, corrected.text);
 assert.equal(provider.state.writes.length, 0, 'neither refusal nor corrected dry-run writes to the provider');
});
