import { productionSender } from './fixtures/production-sender.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 const conflict = await run(true, true, '--env-file', 'sender.env');
 assert.equal(conflict.code, 4, conflict.text);
 assert.ok(conflict.text.includes('rer-packaging.json') && conflict.text.includes('OUTBOUND_SENDER'), 'different declared senders are refused before choosing one');
 await writeFile(join(root, 'rer-packaging.json'), JSON.stringify({ artifact: { specInputs: { publicVariables: { MAIL_FROM } } } }));
 const corrected = await run(true, true, '--env-file', 'sender.env');
 assert.equal(corrected.code, 0, corrected.text);
 assert.equal(provider.state.writes.length, 0, 'neither refusal nor corrected dry-run writes to the provider');
});

// A seed maps the shared MAIL_API_KEY binding to its provider's own environment name.
// The sign-in guidance names each credential once, in the words the person sets.
test('rer deploy --dry-run names a mapped mail credential once', async t => {
 const { root } = await deployProviderFixture(t, {
  vars: { MAIL_PROVIDER: 'sendgrid', MAIL_FROM: 'Support <support@dry-run.example.test>' },
  secrets: [{ binding: 'MAIL_API_KEY', environment: 'SENDGRID_API_KEY' }],
 });
 for (const name of Object.keys(process.env)) if (/^(CLOUDFLARE_|CF_|SENDGRID_|MAIL_)/.test(name)) delete process.env[name];
 t.mock.method(globalThis, 'fetch', () => { throw Error('No network is available during local validation'); });
 let text = '';
 t.mock.method(process.stdout, 'write', chunk => { text += String(chunk); return true; });
 t.mock.method(process.stderr, 'write', chunk => { text += String(chunk); return true; });
 assert.equal(await main(['deploy', '--non-interactive', '--dry-run', '--cwd', root]), 0, text);
 const line = text.split('\n').find(item => item.includes('production sign-in mail'));
 assert.ok(line?.includes('SENDGRID_API_KEY'), text);
 assert.doesNotMatch(line, /\b([A-Z][A-Z0-9_]+) (?:\(or|or) \1\b/, `each credential appears once: ${line}`);
});

// A synthetic seed declares its own policy; Base must call it even when the
// ownership controller handles a secret change instead of the seed deploy hook.
test('the public secret-only deploy enforces seed policy on mapped and direct credentials before provider access', async t => {
 const { root, provider } = await deployProviderFixture(t, {
  vars: { MAIL_PROVIDER: 'none' },
  publicSettings: ['MAIL_MODE', 'MAIL_PROVIDER'],
  secrets: ['MAIL_PROVIDER_API_KEY', 'EMAIL_API_KEY', 'OTHER_SECRET'].map(binding => ({ binding, environment: binding === 'MAIL_PROVIDER_API_KEY' ? 'EMAIL_API_KEY' : binding, optional: true })),
 });
 const source = await readFile(join(root, 'adapter.mjs'), 'utf8');
 const policy = `async ({root,options,environment,env,bindings,declaration,declarationPath}) => {
  const {appendFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const {missing} = await import(${JSON.stringify(new URL('./errors.mjs', import.meta.url).href)});
  // This seed owns OFF. Declaration-mapped bindings expose credentials even
  // when the caller supplies their environment alias.
  await appendFile(join(root,'policy.jsonl'), JSON.stringify({environment,declarationPath,names:Object.keys(bindings),selected:options.setSecret,mapped:bindings.MAIL_PROVIDER_API_KEY===env.EMAIL_API_KEY,declared:declaration.secrets.some(item=>item.binding==='MAIL_PROVIDER_API_KEY')})+'\\n');
  if (env.MAIL_MODE === 'broken') throw Error('Seed policy could not be evaluated');
  const named = options.setSecret?.split(',') ?? Object.keys(bindings);
  if (env.MAIL_MODE === 'off' && named.some(name => ['MAIL_PROVIDER_API_KEY','EMAIL_API_KEY'].includes(name) && bindings[name]?.trim())) throw missing('Credentials are not bound while email is off.');
 }`;
 await writeFile(join(root, 'adapter.mjs'), source.replace('...lifecycle,deploy:', `...lifecycle,mailOffSignIn:'rer signin',deployPolicy:${policy},deploy:`).replace("deploy:ownerDeploy('deploy.json',lifecycle)", "deploy:Object.assign(async context => ownerDeploy('deploy.json',lifecycle)(context),{managesHostedOwner:true})"));
 execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-qam','declare seed policy'], {cwd:root,stdio:'pipe'});
 const policyCalls = () => readFile(join(root, 'policy.jsonl'), 'utf8').then(text => text.trim().split('\n').map(JSON.parse), () => []);
 let output = '', diagnostics = '';
 t.mock.method(process.stdout, 'write', chunk => { output += String(chunk); return true; });
 t.mock.method(process.stderr, 'write', chunk => { diagnostics += String(chunk); return true; });
 const run = async (...flags) => {
  output = ''; diagnostics = '';
  const code = await main(['deploy', '--cwd', root, '--environment', 'secret-off', ...(flags.includes('--set-secret') ? ['--owner-name', 'Maya Chen'] : []), '--non-interactive', '--json', ...flags]);
  return { code, text: output + diagnostics, events: output.trim().split('\n').filter(Boolean).map(JSON.parse) };
 };
 // Establish a receipt entirely against the provider fake, through the deploy door.
 const initial = await run();
 assert.equal(initial.code, 0, initial.text);
 await writeFile(join(root, 'deploy.env'), 'MAIL_MODE=off\nMAIL_PROVIDER=none\nEMAIL_API_KEY=synthetic-base-1\nOTHER_SECRET=synthetic-base-2\n', { mode: 0o600 });
 const receipt = await readFile(join(root, '.rer/deploy/secret-off.json'));
 for (const binding of ['MAIL_PROVIDER_API_KEY', 'EMAIL_API_KEY']) {
  const calls = provider.state.calls.length, before = (await policyCalls()).length;
  const denied = await run('--env-file', 'deploy.env', '--set-secret', binding);
  t.diagnostic(`${binding}: exit=${denied.code}; provider requests=${provider.state.calls.length - calls}`);
  assert.equal(denied.code, 3, denied.text);
  assert.equal(denied.events.find(event => event.event === 'error')?.code, 'missing_input');
  assert.match(denied.text, /Credentials are not bound while email is off/);
  const seen = await policyCalls();
  assert.equal(seen.length, before + 1, 'policy runs once before secret dispatch');
  assert.equal(seen.at(-1).mapped, true, 'policy gets declaration-mapped values');
  assert.equal(seen.at(-1).declared, true);
  assert.equal(seen.at(-1).environment, 'secret-off');
  assert.equal(seen.at(-1).declarationPath, 'deploy.json');
  assert.equal(provider.state.calls.length, calls, 'refusal precedes even account/subdomain lookup');
  assert.deepEqual(await readFile(join(root, '.rer/deploy/secret-off.json')), receipt);
  assert.ok(!denied.text.includes('synthetic-base-1'));
 }
 // Use the executable public door too, with a deny-all fetch edge. The
 // synthetic receipt above is real kit state, with no provider reachable here.
 const requests = join(root, 'requests.txt'), network = join(root, 'network.mjs');
 await writeFile(requests, '');
 await writeFile(network, `import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(requests)},'request\\n');throw Error('No provider access allowed')};`);
 const child = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/rer.mjs', import.meta.url)), 'deploy', '--cwd', root, '--environment', 'secret-off', '--env-file', 'deploy.env', '--set-secret', 'MAIL_PROVIDER_API_KEY', '--owner-name', 'Maya Chen', '--non-interactive', '--json'], { cwd: root, env: { ...process.env, HOME: root, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(network).href}`].filter(Boolean).join(' ') } }).then(() => assert.fail('OFF must refuse'), error => error);
 assert.equal(child.code, 3, child.stdout + child.stderr);
 assert.match(child.stdout, /"code":"missing_input"/);
 assert.equal(await readFile(requests, 'utf8'), '', 'the executable refuses before any network contact');
 t.diagnostic('bin/rer.mjs: exit=3; provider requests=0');
 const allowed = await run('--env-file', 'deploy.env', '--set-secret', 'OTHER_SECRET');
 assert.equal(allowed.code, 0, allowed.text);
 assert.equal(provider.state.secrets.find(item => item.name === 'OTHER_SECRET')?.value, 'synthetic-base-2');
 assert.ok(!provider.state.secrets.some(item => item.name === 'MAIL_PROVIDER_API_KEY' || item.name === 'EMAIL_API_KEY'));
 const calls = provider.state.calls.length, before = (await policyCalls()).length;
 const full = await run('--env-file', 'deploy.env');
 assert.equal(full.code, 3, full.text);
 assert.equal((await policyCalls()).length, before + 1, 'ordinary deploy also invokes seed policy');
 assert.equal(provider.state.calls.length, calls);
 // Allowed alias updates keep the declaration's environment mapping.
 await writeFile(join(root, 'deploy.env'), 'MAIL_MODE=on\nEMAIL_API_KEY=synthetic-base-3\n', {mode:0o600});
 const enabled = await run('--env-file', 'deploy.env', '--set-secret', 'MAIL_PROVIDER_API_KEY');
 assert.equal(enabled.code, 0, enabled.text);
 assert.equal(provider.state.secrets.find(item => item.name === 'MAIL_PROVIDER_API_KEY')?.value, 'synthetic-base-3');
 // Opting in does not alter the existing shared production-mail preflight.
 const afterAllowed = provider.state.calls.length;
 const declaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 await writeFile(join(root, 'deploy.json'), JSON.stringify({ ...declaration, vars: { MAIL_PROVIDER: 'resend' } }));
 const shared = await run();
 assert.equal(shared.code, 4, shared.text);
 assert.match(shared.text, /Production sign-in is not configured/);
 assert.equal(provider.state.calls.length, afterAllowed);
 // An unclassified hook failure names its own lifecycle step, while the
 // missing-input refusals above keep their exit-3 path and message.
 await writeFile(join(root, 'deploy.env'), 'MAIL_MODE=broken\n', {mode:0o600});
 const broken = await run('--env-file', 'deploy.env', '--set-secret', 'OTHER_SECRET');
 assert.equal(broken.code, 1, broken.text);
 const failure = broken.events.find(event => event.event === 'error');
 assert.equal(failure.code, 'command_failed');
 assert.match(failure.message, /Checking deploy policy failed/);
 assert.doesNotMatch(failure.message, /Checking pinned pnpm/);
 assert.equal(provider.state.calls.length, afterAllowed, 'an ordinary policy error also precedes provider access');
});
