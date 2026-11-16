import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportReference } from '../scripts/export-reference.mjs';
import { checkout, account } from './fixtures/owner-deploy.mjs';
import { productionSender } from './fixtures/production-sender.mjs';
import { main } from './main.mjs';
import { packaging } from '../modules/delivery-producer/cli.mjs';

const base = new URL('../', import.meta.url).pathname;

// One seed, public commands, and only the Cloudflare / hosted-owner network edge is fake.
test('a declared public setting switches mail in place while check and managed packaging keep its default', async t => {
 const vars = { MAIL_PROVIDER: 'none', MAIL_FROM: productionSender, MAIL_RELAY_URL: '' };
 const declaration = { vars, publicSettings: ['MAIL_PROVIDER'], d1: [{ binding: 'DB' }], secrets: [
  ...['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN'].map(binding => ({ binding, environment: binding })),
  { binding: 'MAIL_API_KEY', environment: 'SENDGRID_API_KEY', optional: true },
 ] };
 const { root, git } = await checkout(t, declaration);
 const savedDeclaration = JSON.parse(await readFile(join(root, 'deploy.json'), 'utf8'));
 const exported = join(root, 'exported');
 await exportReference(base, exported);
 await cp(exported, root, { recursive: true });
 await rm(exported, { recursive: true });
 await writeFile(join(root, 'deploy.json'), JSON.stringify(savedDeclaration));
 await writeFile(join(root, '.gitignore'), '\n.rer/\ndeploy.env\ndelivery-artifact/\n', { flag: 'a' });
 const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 pkg.engines.node = process.versions.node;
 await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
 await writeFile(join(root, '.node-version'), process.versions.node + '\n');
 const wrangler = { main: 'index.js', compatibility_date: '2026-09-08', no_bundle: true,
  rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }], vars };
 await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ ...wrangler, main: 'src/server.ts' }));
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify(wrangler));
 // Retain the real exported command contract; the fixture build is already on disk.
 const adapterPath = join(root, 'scripts/installer/local.mjs');
 let adapter = await readFile(adapterPath, 'utf8');
 adapter = adapter.replace("'../base-cli/cli/deploy.mjs'", JSON.stringify(new URL('./deploy.mjs', import.meta.url).href)).replace('const lifecycle = operatorInstaller(', 'const installedLifecycle = operatorInstaller(')
  .replace('export const adapter = lifecycle;', "const lifecycle = { ...installedLifecycle, run: async () => {}, mailOffSignIn: 'rer signin --environment production' };\nexport const adapter = lifecycle;")
  .replace('dev: developmentTarget,', "mailOffSignIn: 'rer signin --environment production', dev: developmentTarget,");
 await writeFile(adapterPath, adapter);
 // The network fixture owns this admitted identity in D1.
 await mkdir(join(root, 'migrations/core'), { recursive: true });
 const { provider, claims } = account(t);
 const savedCI = process.env.CI; process.env.CI = 'true';
 t.after(() => { if (savedCI === undefined) delete process.env.CI; else process.env.CI = savedCI; });
 const output = [];
 t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
 t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
 const run = async (...flags) => {
  output.length = 0;
  const code = await main(['deploy', '--cwd', root, '--json', '--non-interactive', '--no-queue', ...flags]);
  return { code, text: output.join('') };
 };
 const save = async value => { await writeFile(join(root, 'deploy.json'), JSON.stringify(value)); git('add', '.'); git('commit', '-qm', 'fixture declaration'); };
 const check = () => {
  const result = spawnSync(process.execPath, [join(base, 'bin/rer.mjs'), 'check', '--cwd', root, '--json'], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: process.env.HOME, RER_NO_UPDATE_CHECK: '1' } });
  return { ...result, report: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
 };
 const policy = { schema: 1, project: { schema: 1, projectId: 'tests/fixture', name: 'Fixture', sourceRepository: 'https://github.com/octocat/Hello-World', license: 'MIT',
  deployment: { target: 'cloudflare-workers', artifactFile: 'app.json' }, operations: { build: 'make build', verify: 'make verify', artifact: 'make artifact', recovery: 'Restore retained data.' } },
  managed: { workflowRef: `publisher/delivery/.github/workflows/trusted-build.yml@${'a'.repeat(40)}`, artifactFile: 'app.json', buildProfile: 'project', verificationProfiles: ['full'] },
  artifact: { specInputs: { mail: { providers: ['rer', 'sendgrid'] }, publicVariableNames: Object.keys(vars), optionalSecretNames: ['MAIL_API_KEY'], recovery: 'Restore retained data.' } } };
 await writeFile(join(root, 'rer-packaging.json'), JSON.stringify(policy));
 git('add', '.'); git('commit', '-qm', 'fixture seed');
 const initial = await run('--owner-name', 'Maya Chen');
 assert.equal(initial.code, 0, initial.text);
 // Existing seeds keep the old refusal until they opt in with a deploy.json edit.
 for (const flag of ['--set-secret', '--unset-secret']) {
  const refused = await run(flag, 'MAIL_PROVIDER');
  assert.notEqual(refused.code, 0, refused.text);
  assert.match(refused.text, /does not list as a secret/);
  for (const key of ['publicSettings', 'optional', 'vars']) assert.ok(refused.text.includes(key), refused.text);
  t.diagnostic(`Before declaration: ${flag} refused as undeclared.`);
 }
 await writeFile(join(root, 'deploy.env'), 'SENDGRID_API_KEY=synthetic-base-1\n', { mode: 0o600 });
 const plain = await run('--env-file', 'deploy.env');
 assert.equal(plain.code, 4, plain.text);
 assert.match(plain.text, /MAIL_PROVIDER=none/);
 
 savedDeclaration.secrets.push({ binding: 'MAIL_PROVIDER', environment: 'OUTBOUND_PROVIDER', optional: true });
 await save(savedDeclaration);
 const checked = check();
 t.diagnostic(`Declared check: exit ${checked.status}; ${JSON.stringify(checked.report.clauses.filter(item => !item.ok))}`);
 const withoutProvider = { ...vars }; delete withoutProvider.MAIL_PROVIDER;
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({ ...wrangler, vars: withoutProvider }));
 await assert.rejects(packaging(['artifact', '--root', root, '--output', 'delivery-artifact/missing.json']), error => { t.diagnostic('Without Wrangler default: ' + error.message); return /Managed mail requires public MAIL_PROVIDER/.test(error.message); });
 await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify(wrangler));
 assert.equal(checked.status, 0, JSON.stringify(checked.report.clauses.filter(item => !item.ok)) + checked.stderr);
 const emitted = await packaging(['artifact', '--root', root, '--output', 'delivery-artifact/first.json']);
 assert.equal(JSON.parse(await readFile(emitted)).deploymentSpec.publicVariables.MAIL_PROVIDER, 'none');
 const first = await run('--owner-name', 'Maya Chen');
 assert.equal(first.code, 0, first.text);
 const statePath = join(root, '.rer/deploy/production.json');
 const before = JSON.parse(await readFile(statePath));
 assert.equal(before.ownerClaim.outcome, 'claimed');
 assert.equal(provider.state.settings.bindings.find(item => item.name === 'MAIL_PROVIDER')?.text, 'none');
 const changed = await run('--env-file', 'deploy.env', '--set-secret', 'MAIL_PROVIDER=sendgrid', '--set-secret', 'MAIL_API_KEY');
 assert.equal(changed.code, 0, changed.text);
 assert.equal(provider.state.secrets.find(item => item.name === 'MAIL_PROVIDER')?.value, 'sendgrid');
 assert.ok(!changed.text.includes('synthetic-base-1'), 'the sending credential stays masked');
 const held = await run();
 assert.equal(held.code, 0, held.text);
 assert.equal(provider.state.secrets.find(item => item.name === 'MAIL_PROVIDER')?.value, 'sendgrid', 'plain deploy preserves the held selection');
 const writes = provider.state.writes.length;
 const privateAssignment = await run('--set-secret', 'MAIL_API_KEY=synthetic-base-2');
 assert.equal(privateAssignment.code, 2, privateAssignment.text);
 assert.ok(!privateAssignment.text.includes('synthetic-base-2'));
 assert.equal(provider.state.writes.length, writes, 'public assignment syntax cannot publish a credential');
 const off = await run('--unset-secret', 'MAIL_PROVIDER,MAIL_API_KEY');
 assert.equal(off.code, 0, off.text);
 assert.equal(provider.state.settings.bindings.find(item => item.name === 'MAIL_PROVIDER')?.text, 'none');
 assert.ok(!provider.state.secrets.some(item => ['MAIL_PROVIDER', 'MAIL_API_KEY'].includes(item.name)));
 const after = JSON.parse(await readFile(statePath));
 assert.deepEqual(after.owned, before.owned);
 assert.deepEqual(after.ownerClaim, before.ownerClaim);
 assert.equal(claims.length, 1, 'the admitted owner is preserved throughout');
 assert.equal(after.receipt.health.ok, true);
 const repeated = await run();
 assert.equal(repeated.code, 0, repeated.text);
 assert.equal(claims.length, 1);
 const last = await packaging(['artifact', '--root', root, '--output', 'last-artifact/app.json']);
 assert.equal(JSON.parse(await readFile(last)).deploymentSpec.publicVariables.MAIL_PROVIDER, 'none');
 assert.equal(check().status, 0);
 t.diagnostic('After declaration: check and managed spec pass; none -> sendgrid -> none preserves the admitted owner and custody.');
});
