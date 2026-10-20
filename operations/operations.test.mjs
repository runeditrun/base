import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectOperations, describeOperations } from './operations.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'OPERATIONS.md'), 'Operations');
  await writeFile(join(root, 'ACCEPTANCE.md'), 'Acceptance');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { setup: 'node scripts/setup.mjs', deploy: 'node scripts/setup.mjs', verify: 'node scripts/setup.mjs' } }));
  await writeFile(join(root, 'scripts/setup.mjs'), "throw new Error('Operation must never execute during inspection');");
  await writeFile(join(root, 'scripts/operations-config.mjs'), "export function validateConfiguration(env) { if (env.SECRET === 'bad-private-value') throw new Error(env.SECRET); }");
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 1, edition: 'test', requiredEnvironment: ['SECRET'], acceptance: { document: 'ACCEPTANCE.md' }, commands: Object.fromEntries(['setup', 'deploy', 'verify'].map(name => [name, { argv: ['pnpm', 'run', name], effects: 'test operation' }])) }));
  return root;
}
test('reports all missing inputs without executing operational commands', async t => {
  const report = await inspectOperations(await fixture(t), {});
  assert.equal(report.ok, false);
  assert.deepEqual(report.missingEnvironment, ['SECRET']);
  assert.equal(report.commands.every(command => command.available), true);
  assert.equal(report.scope, 'local-inputs-only');
});
test('invalid configuration never discloses values or exception contents', async t => {
  const root = await fixture(t);
  const report = await inspectOperations(root, { SECRET: 'bad-private-value' });
  assert.equal(report.configuration, 'invalid');
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes('bad-private-value'), false);
  const checked = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH, SECRET: 'bad-private-value' }, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.equal(JSON.parse(checked.stdout).configuration, 'invalid');
  assert.match(checked.stderr, /Configuration is invalid; validator details are suppressed\./);
  assert.equal(`${checked.stdout}${checked.stderr}`.includes('bad-private-value'), false);
});
test('missing actual script target fails even when package entry exists', async t => {
  const root = await fixture(t);
  await rm(join(root, 'scripts/setup.mjs'));
  const report = await inspectOperations(root, { SECRET: 'present' });
  assert.equal(report.ok, false);
  assert.equal(report.commands.every(command => !command.available), true);
  const checked = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH, SECRET: 'present' }, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).commands.map(command => command.available), [false, false, false]);
  assert.match(checked.stderr, /Unavailable targets: setup, deploy, verify/);
});
test('valid local inputs retain explicit unchecked cloud and acceptance scope', async t => {
  const report = await inspectOperations(await fixture(t), { SECRET: 'private-value' });
  assert.equal(report.ok, true);
  assert.equal(report.unchecked.includes('product acceptance'), true);
  assert.equal(JSON.stringify(report).includes('private-value'), false);
});
test('CLI exit statuses and strict arguments keep output machine-readable', async t => {
  const root = await fixture(t);
  const command = args => spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, ...args], { cwd: root, env: { ...process.env, SECRET: '' }, encoding: 'utf8' });
  assert.equal(command(['describe']).status, 0);
  const checked = command(['check']);
  assert.equal(checked.status, 1);
  assert.equal(JSON.parse(checked.stdout).ok, false);
  assert.match(checked.stderr, /Missing inputs:[\s\S]*SECRET/);
  assert.match(checked.stderr, /Missing inputs are expected before a deployment is configured\./);
  const valid = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH, SECRET: 'configured-value' }, encoding: 'utf8' });
  assert.equal(valid.status, 0);
  assert.equal(JSON.parse(valid.stdout).ok, true);
  assert.match(valid.stderr, /Operations check passed/);
  assert.equal(valid.stdout.includes('Operations check passed'), false);
  const invalid = command(['deploy']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).ok, false);
});

test('v1 environment sources describe where missing required inputs come from', async t => {
  const root = await fixture(t);
  const descriptor = JSON.parse(await readFile(join(root, 'OPERATIONS.json'), 'utf8'));
  for (const source of ['Owner file', 'OPERATIONS.md', 'README.md', '1Password production vault, application integration item']) {
    descriptor.environmentSources = { SECRET: source };
    await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
    assert.deepEqual((await describeOperations(root)).environmentSources, descriptor.environmentSources);
  }
  descriptor.environmentSources = { SECRET: 'README.md' };
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  const checked = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH, SECRET: '' }, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).missingEnvironment, ['SECRET']);
  assert.match(checked.stderr, /SECRET — README.md/);
});

test('fresh checkout reports named missing inputs and gives a safe describe next step', async t => {
  const root = await fixture(t);
  const descriptor = JSON.parse(await readFile(join(root, 'OPERATIONS.json'), 'utf8'));
  descriptor.environmentSources = { SECRET: 'Team vault, production service credentials collection' };
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  // Copied into an independent checkout, the advice names the inspector where it lives.
  await mkdir(join(root, 'scripts'), { recursive: true });
  for (const name of ['operations.mjs', 'project-operations.mjs']) await copyFile(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
  const checked = spawnSync(process.execPath, ['scripts/operations.mjs', 'check'], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.equal(JSON.parse(checked.stdout).ok, false);
  assert.match(checked.stderr, /SECRET — Team vault, production service credentials collection/);
  assert.match(checked.stderr, /node scripts\/operations\.mjs describe/);
  assert.equal(`${checked.stdout}${checked.stderr}`.includes('operation must never execute'), false);
});

test('environment source declarations reject unknown inputs, URLs, tokens and oversized text in v1 describe and check', async t => {
  const root = await fixture(t);
  const descriptor = JSON.parse(await readFile(join(root, 'OPERATIONS.json'), 'utf8'));
  const invalidSources = [
    { OTHER: '1Password production vault, application integration item' },
    { SECRET: 'Visit https://example.test/token?token=visible-source-secret' },
    { SECRET: 'Visit example.test/token' },
    { SECRET: 'GitHub Actions token: ghp_abcdefghijklmnopqrstuvwx' },
    { SECRET: 'Token source key ABCDEFGHIJKLMNOPQRST' },
    { SECRET: `Team secret manager ${'x'.repeat(181)}` },
    { SECRET: 'short' },
    { SECRET: 'First line\nsecond line' }
  ];
  for (const environmentSources of invalidSources) {
    descriptor.environmentSources = environmentSources;
    await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
    await assert.rejects(describeOperations(root));
    await assert.rejects(inspectOperations(root, {}));
    const checked = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(checked.status, 1);
    assert.equal(checked.stdout, '');
    assert.equal(`${checked.stdout}${checked.stderr}`.includes('visible-source-secret'), false);
    assert.equal(`${checked.stdout}${checked.stderr}`.includes('abcdefghijklmnopqrstuvwx'), false);
  }
});
test('describe rejects missing targets, acceptance docs and malformed descriptors without credentials', async t => {
  const root = await fixture(t);
  assert.equal((await describeOperations(root)).edition, 'test');
  await rm(join(root, 'scripts/setup.mjs'));
  await assert.rejects(describeOperations(root));
  await writeFile(join(root, 'scripts/setup.mjs'), '');
  await rm(join(root, 'ACCEPTANCE.md'));
  await assert.rejects(describeOperations(root));
  await writeFile(join(root, 'ACCEPTANCE.md'), '');
  await writeFile(join(root, 'OPERATIONS.json'), '{"version":1}');
  await assert.rejects(describeOperations(root));
});

async function projectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'verify.py'), 'from pathlib import Path\nPath("verified.txt").write_text("verified")\n');
  const descriptor = { version: 2, project: 'independent-python', runtime: { requirements: [{ name: 'python', version: '>=3' }] }, requiredEnvironment: [], commands: {
    verify: { argv: ['python3', 'verify.py'], inputs: ['verify.py'], effects: 'Writes a local verification result; no provider effects.' }
  } };
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  return { root, descriptor };
}

test('independent Python project inspects and runs its own command without edition, seed, package or pnpm files', async t => {
  const { root, descriptor } = await projectFixture(t);
  assert.deepEqual(await describeOperations(root), descriptor);
  const report = await inspectOperations(root, {});
  assert.equal(report.ok, true);
  assert.equal(report.project, 'independent-python');
  assert.equal('edition' in report, false);
  const { readFile } = await import('node:fs/promises');
  await assert.rejects(readFile(join(root, 'verified.txt')));
  const [executable, ...args] = descriptor.commands.verify.argv;
  const run = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(join(root, 'verified.txt'), 'utf8'), 'verified');
});

test('project commands require effects and reject escaping input paths', async t => {
  const { root, descriptor } = await projectFixture(t);
  descriptor.commands.verify.effects = '';
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  await assert.rejects(describeOperations(root));
  descriptor.commands.verify.effects = 'Local file writes';
  descriptor.commands.verify.inputs = ['../outside'];
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  await assert.rejects(describeOperations(root));
});

test('missing declared project inputs fail inspection without executing the command', async t => {
  const { root } = await projectFixture(t);
  await rm(join(root, 'verify.py'));
  assert.equal((await inspectOperations(root, {})).ok, false);
  await assert.rejects(describeOperations(root));
});

test('project configuration validation is optional, local and redacts exceptions', async t => {
  const { root, descriptor } = await projectFixture(t);
  descriptor.configuration = { module: 'config.mjs' };
  await writeFile(join(root, 'config.mjs'), 'export function validateConfiguration(env) { throw new Error(env.SECRET); }');
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  const report = await inspectOperations(root, { SECRET: 'synthetic-private-project-value' });
  assert.equal(report.configuration, 'invalid');
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes('synthetic-private-project-value'), false);
});

test('v2 source map accepts selected mail input names and check names missing values without exposing them in JSON', async t => {
  const { root, descriptor } = await projectFixture(t);
  descriptor.loops = [{ id: 'ticket-replies', type: 'mail', required: true, enabled: true, provider: 'resend' }];
  descriptor.environmentSources = { RESEND_API_KEY: '1Password production vault, mail integration item' };
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  assert.deepEqual((await describeOperations(root)).environmentSources, descriptor.environmentSources);
  const checked = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).loops[0].missingEnvironment, ['RESEND_API_KEY']);
  assert.equal(checked.stdout.includes('1Password production vault'), false);
  assert.match(checked.stderr, /RESEND_API_KEY — 1Password production vault, mail integration item/);
});

test('v2 environment sources reject unknown, URL and token values in describe and check', async t => {
  const token = `sk_live_${randomBytes(16).toString('hex')}`;
  const { root, descriptor } = await projectFixture(t);
  descriptor.loops = [{ id: 'ticket-replies', type: 'mail', required: true, enabled: true, provider: 'resend' }];
  for (const environmentSources of [
    { SENDGRID_API_KEY: '1Password production vault, mail integration item' },
    { RESEND_API_KEY: 'Visit https://example.test/token?token=visible-v2-secret' },
    { RESEND_API_KEY: `Production token: ${token}` }
  ]) {
    descriptor.environmentSources = environmentSources;
    await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
    await assert.rejects(describeOperations(root));
    await assert.rejects(inspectOperations(root, {}));
    const checked = spawnSync(process.execPath, [new URL('./operations.mjs', import.meta.url).pathname, 'check'], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(checked.status, 1);
    assert.equal(checked.stdout, '');
    assert.equal(`${checked.stdout}${checked.stderr}`.includes('visible-v2-secret'), false);
    assert.equal(`${checked.stdout}${checked.stderr}`.includes(token), false);
  }
});

test('project declared inputs cannot escape via symlinks or name directories', async t => {
  const { root, descriptor } = await projectFixture(t);
  const { symlink } = await import('node:fs/promises');
  await symlink(process.execPath, join(root, 'outside'));
  descriptor.commands.verify.inputs = ['outside'];
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  await assert.rejects(describeOperations(root));
  descriptor.commands.verify.inputs = ['.'];
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  await assert.rejects(describeOperations(root));
});
