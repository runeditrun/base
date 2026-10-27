import { caseRows } from '../onboarding/test-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeOperations, inspectOperations, validateEnvironmentSources } from './operations.mjs';

const generated = () => randomBytes(5).toString('hex');
const unsafeSources = () => {
  const value = generated();
  return [
    ...['MY_API_KEY', 'APP_SECRET', 'SERVICE_AUTH_TOKEN', 'DB_PASSWORD', 'CUSTOM_INPUT'].map(name => `Team vault ${name}=${value}`),
    ...['MY_API_KEY', 'servicePassword', 'database.password', 'CLIENT_SECRET_DEV', 'STRIPE_KEY', 'APP_CREDENTIALS'].map(name => `Team vault ${name}: ${value}`),
    `Team vault {"MY_API_KEY":"${value}"}`,
    `Team vault 'DB_PASSWORD': '${value}'`,
    `Team vault SG.${generated()}.${generated()}`,
    `Team vault sk_live_${generated()}`,
    `Team vault rk_test_${generated()}`,
    `Team vault whsec_${generated()}`,
    `Team vault eyJ${generated()}.${generated()}.${generated()}`,
    `Team vault AKIA${randomBytes(8).toString('hex').toUpperCase()}`,
    `Team vault AIza${randomBytes(10).toString('hex')}`,
    `Team vault ghp_${generated()}`,
    `Team vault xoxb-${generated()}`
  ];
};

test("environment source guidance rejects credential values through native and copied inspectors", t => caseRows(t, [
  ['source guidance rejects embedded assignments and provider tokens with generic errors', () => {
  for (const source of unsafeSources()) {
    // Compare only generic errors: a failed assertion must never print a value.
    let error;
    try { validateEnvironmentSources({ environmentSources: { INPUT: source } }, new Set(['INPUT'])); }
    catch (caught) { error = caught; }
    assert.equal(error?.message === 'Invalid environment source declaration.', true);
  }
  for (const source of ['OPERATIONS.md', 'docs/OPERATIONS.md#mail', 'Team vault: production mail item', 'Ask the owner for the production mail key']) {
    validateEnvironmentSources({ environmentSources: { INPUT: source } }, new Set(['INPUT']));
  }
}],
  ...[1, 2].map(version => [`v${version} copied inspector rejects unsafe sources before describe or check output`, async t => {
    const { root, save, run } = await copiedInspector(t, version);
    for (const source of unsafeSources()) {
      await save(source);
      await assert.rejects(describeOperations(root), { message: 'Invalid environment source declaration.' });
      await assert.rejects(inspectOperations(root, {}), { message: 'Invalid environment source declaration.' });
      for (const command of ['describe', 'check']) {
        const result = run(command);
        assert.equal(result.status, 1);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.includes(source), false);
        // Whitelist all emitted text, including the next command. No fragment of
        // a source value or parser exception can hide alongside a generic error.
        const lines = result.stderr.trim().split('\n');
        if (command === 'check') {
          assert.equal(lines.shift() === 'Operations check failed: descriptor or local configuration is invalid or unreadable; details are suppressed. Next: read OPERATIONS.md for recovery guidance, repair the descriptor or its referenced files, then rerun check.', true);
        }
        assert.equal(lines.length, 1);
        assert.equal(lines[0] === JSON.stringify({ ok: false, error: 'Invalid command or unreadable operations files. Usage: node scripts/operations.mjs describe|check' }), true);
      }
    }
    await save('OPERATIONS.md');
    const described = run('describe');
    assert.equal(described.status, 0);
    assert.equal(JSON.parse(described.stdout).environmentSources.INPUT, 'OPERATIONS.md');
    const checked = run('check');
    assert.equal(checked.status, 1);
    assert.deepEqual(JSON.parse(checked.stdout).missingEnvironment, ['INPUT']);
    assert.match(checked.stderr, /Missing inputs are expected before a deployment is configured\./);
    assert.match(checked.stderr, /INPUT — OPERATIONS\.md/);
    assert.equal(checked.stderr.trim().split('\n').at(-1) === (version === 1
      ? 'Next: read OPERATIONS.md, then run the declared setup command when ready: pnpm run setup. For secondary descriptor inspection, run node scripts/operations.mjs describe.'
      : 'Next: read the project setup documentation for setup guidance. No setup command is declared. For secondary descriptor inspection, run node scripts/operations.mjs describe.'), true);
    const parserMarker = generated();
    await writeFile(join(root, 'OPERATIONS.json'), `{"version":${version},"environmentSources":{"INPUT":"${parserMarker}`);
    for (const command of ['describe', 'check']) {
      const result = run(command);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.includes(parserMarker), false);
      assert.equal(result.stderr.includes('SyntaxError'), false);
      const lines = result.stderr.trim().split('\n');
      if (command === 'check') {
        assert.equal(lines.shift() === 'Operations check failed: descriptor or local configuration is invalid or unreadable; details are suppressed. Next: read OPERATIONS.md for recovery guidance, repair the descriptor or its referenced files, then rerun check.', true);
      }
      assert.equal(lines.length, 1);
      assert.equal(lines[0] === JSON.stringify({ ok: false, error: 'Invalid command or unreadable operations files. Usage: node scripts/operations.mjs describe|check' }), true);
    }
  }])
]));

async function copiedInspector(t, version) {
  const root = await mkdtemp(join(tmpdir(), 'operations-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const name of ['operations.mjs', 'project-operations.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(root, 'scripts', name));
  }
  await writeFile(join(root, 'verify.mjs'), 'throw new Error("Inspection must never execute commands");');
  const descriptor = version === 1
    ? { version, edition: 'source-validation', requiredEnvironment: ['INPUT'], acceptance: { document: 'ACCEPTANCE.md' }, commands: Object.fromEntries(['setup', 'deploy', 'verify'].map(name => [name, { argv: ['pnpm', 'run', name], effects: 'Local verification' }])) }
    : { version, project: 'source-validation', runtime: { requirements: [] }, requiredEnvironment: ['INPUT'], commands: { verify: { argv: ['node', 'verify.mjs'], inputs: ['verify.mjs'], effects: 'Local verification' } } };
  if (version === 1) {
    await writeFile(join(root, 'OPERATIONS.md'), 'Operations');
    await writeFile(join(root, 'ACCEPTANCE.md'), 'Acceptance');
    await writeFile(join(root, 'scripts/operations-config.mjs'), 'export function validateConfiguration() {}');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(['setup', 'deploy', 'verify'].map(name => [name, 'node verify.mjs'])) }));
  }
  const save = source => writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ ...descriptor, environmentSources: { INPUT: source } }));
  const run = command => spawnSync(process.execPath, ['scripts/operations.mjs', command], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
  return { root, save, run };
}
