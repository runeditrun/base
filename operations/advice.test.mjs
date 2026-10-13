import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';


async function fixture(t, { requiredEnvironment = ['MAIL_API_KEY', 'APP_ORIGIN'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'operations-advice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'OPERATIONS.md'), 'Setup guidance');
  await writeFile(join(root, 'ACCEPTANCE.md'), 'Acceptance');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
    adopt: 'node scripts/setup.mjs', deploy: 'node scripts/setup.mjs', verify: 'node scripts/setup.mjs'
  } }));
  await writeFile(join(root, 'scripts/setup.mjs'), "throw new Error('Inspection must never execute setup');");
  await writeFile(join(root, 'scripts/operations-config.mjs'), `export function validateConfiguration(env) {
    if (!env.MAIL_API_KEY) throw new Error('MAIL_API_KEY is required');
    if (!env.APP_ORIGIN?.startsWith('https://')) throw new Error('Invalid APP_ORIGIN: ' + env.APP_ORIGIN);
  }`);
  const descriptor = {
    version: 1,
    edition: 'synthetic-advice-test',
    requiredEnvironment,
    acceptance: { document: 'ACCEPTANCE.md' },
    commands: {
      setup: { argv: ['pnpm', 'run', 'adopt', '--', '--profile', 'local'], effects: 'Synthetic setup command.' },
      deploy: { argv: ['pnpm', 'run', 'deploy'], effects: 'Synthetic deploy command.' },
      verify: { argv: ['pnpm', 'run', 'verify'], effects: 'Synthetic verify command.' }
    }
  };
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
  return root;
}

// An independent project copies the inspector pair into its own checkout.
async function runCheck(root, env) {
  await mkdir(join(root, 'scripts'), { recursive: true });
  for (const name of ['operations.mjs', 'project-operations.mjs']) await copyFile(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name));
  return spawnSync(process.execPath, ['scripts/operations.mjs', 'check'], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8'
  });
}

test('missing MAIL_API_KEY with a throwing validator defers configuration judgment and names the declared setup command', async t => {
  const root = await fixture(t);
  const checked = await runCheck(root, { APP_ORIGIN: 'https://workspace.example' });
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).missingEnvironment, ['MAIL_API_KEY']);
  assert.match(checked.stderr, /MAIL_API_KEY — see OPERATIONS\.md/);
  assert.match(checked.stderr, /Configuration is checked again once these inputs are set\./);
  assert.doesNotMatch(checked.stderr, /Configuration is invalid/);
  assert.match(checked.stderr, /pnpm run adopt -- --profile local/);
  assert.match(checked.stderr, /node scripts\/operations\.mjs describe/);
  assert.equal(checked.stderr.trim().split('\n').at(-1), 'Next: read OPERATIONS.md, then run the declared setup command when ready: pnpm run adopt -- --profile local. For secondary descriptor inspection, run node scripts/operations.mjs describe.');
  assert.doesNotMatch(`${checked.stdout}${checked.stderr}`, /Inspection must never execute setup/);
});

test('malformed APP_ORIGIN keeps generic validator suppression and names declared inputs without echoing values', async t => {
  const root = await fixture(t, { requiredEnvironment: ['MAIL_API_KEY', 'APP_ORIGIN'] });
  const checked = await runCheck(root, { MAIL_API_KEY: 'synthetic-mail-key', APP_ORIGIN: 'not a url' });
  assert.equal(checked.status, 1);
  assert.equal(JSON.parse(checked.stdout).configuration, 'invalid');
  assert.match(checked.stderr, /Configuration is invalid; validator details are suppressed\./);
  assert.match(checked.stderr, /Check the values you set for these declared input names: APP_ORIGIN, MAIL_API_KEY\./);
  assert.equal(`${checked.stdout}${checked.stderr}`.includes('not a url'), false);
  assert.equal(`${checked.stdout}${checked.stderr}`.includes('synthetic-mail-key'), false);
  assert.equal(checked.stderr === [
    'Operations check failed: resolve local configuration or target issues before deployment.',
    'Configuration is invalid; validator details are suppressed.',
    'Check the values you set for these declared input names: APP_ORIGIN, MAIL_API_KEY.',
    'Next: read OPERATIONS.md, then run the declared setup command when ready: pnpm run adopt -- --profile local. For secondary descriptor inspection, run node scripts/operations.mjs describe.',
    ''
  ].join('\n'), true);
});

test('unreadable descriptor advice points to OPERATIONS.md recovery, not the failing describe command', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'OPERATIONS.json'), '{invalid descriptor');
  const checked = await runCheck(root, {});
  assert.equal(checked.status, 1);
  assert.equal(checked.stdout.length, 0);
  assert.match(checked.stderr, /read OPERATIONS\.md for recovery guidance/);
  assert.match(checked.stderr, /repair the descriptor or its referenced files/);
  const lines = checked.stderr.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[0], /node scripts\/operations\.mjs describe/);
  assert.equal(lines[0], 'Operations check failed: descriptor or local configuration is invalid or unreadable; details are suppressed. Next: read OPERATIONS.md for recovery guidance, repair the descriptor or its referenced files, then rerun check.');
  assert.equal(lines[1], JSON.stringify({ ok: false, error: 'Invalid command or unreadable operations files. Usage: node scripts/operations.mjs describe|check' }));
});

test('v2 advice names the declared document and preserves shell-quoted setup arguments without executing them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'project-operations-advice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'SETUP.md'), 'Project setup guidance');
  await writeFile(join(root, 'setup.mjs'), "throw new Error('Inspection must never execute project setup');");
  await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({
    version: 2,
    project: 'synthetic-project-advice-test',
    runtime: { requirements: [] },
    requiredEnvironment: ['MAIL_API_KEY'],
    documentation: { document: 'SETUP.md' },
    commands: {
      setup: {
        argv: ['node', 'setup.mjs', '--label', "Owner's local workspace", '$(touch marker)', ''],
        inputs: ['setup.mjs'],
        effects: 'Synthetic project setup command.'
      }
    }
  }));
  const checked = await runCheck(root, {});
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).missingEnvironment, ['MAIL_API_KEY']);
  assert.match(checked.stderr, /MAIL_API_KEY — see SETUP\.md/);
  assert.equal(checked.stderr.trim().split('\n').at(-1), "Next: read SETUP.md, then run the declared setup command when ready: node setup.mjs --label 'Owner'\\''s local workspace' '$(touch marker)' ''. For secondary descriptor inspection, run node scripts/operations.mjs describe.");
  assert.doesNotMatch(`${checked.stdout}${checked.stderr}`, /Inspection must never execute project setup/);
  await assert.rejects(access(join(root, 'marker')), { code: 'ENOENT' });
});
