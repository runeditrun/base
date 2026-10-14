import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/rer.mjs', import.meta.url));

test('public describe uses adapter and OPERATIONS effects without running hooks', async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-describe-effects-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, 'adapter.mjs'), `
import { writeFile } from 'node:fs/promises';
const markHook = () => writeFile(new URL('./hook-ran', import.meta.url), 'ran');
export const commandAdapter = {
 version: 1,
 state: '.local/state',
 settings: [],
 verbs: {
  dev: { flags: ['--help', '--cwd', '--non-interactive', '--json', '--port', '--host', '--no-queue', '--door', '--demo'], effects: 'This seed accepts loopback listeners only.' },
  deploy: { flags: ['--help', '--cwd', '--non-interactive', '--json', '--dry-run', '--no-queue'] },
  preview: { flags: ['--help', '--cwd', '--non-interactive', '--json', '--port', '--host', '--idle-timeout', '--stop', '--no-queue'] },
 },
 dev: markHook,
 deploy: markHook,
};
`);
 const descriptor = {
  version: 2,
  project: 'example/oncall',
  runtime: { requirements: [] },
  requiredEnvironment: [],
  seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' },
  commands: {
   dev: { argv: ['rer', 'dev'], inputs: ['adapter.mjs'], effects: 'See SEED-COMMAND-CONTRACT.md for dev effects.' },
   deploy: { argv: ['rer', 'deploy'], inputs: ['adapter.mjs'], effects: 'Hosted deployment is held pending an independent standby.' },
  },
 };
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 const describe = () => {
  const result = spawnSync(process.execPath, [cli, 'describe', '--json'], {
   cwd: root,
   encoding: 'utf8',
   timeout: 10000,
   env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
 };

 const first = describe();
 assert.equal(first.verbs.dev.effects, 'This seed accepts loopback listeners only.');
 assert.equal(first.verbs.deploy.effects, descriptor.commands.deploy.effects);
 assert.ok(first.verbs.dev.flags.includes('--port'));
 assert.ok(!first.verbs.dev.flags.includes('--site'));
 assert.ok(first.verbs.deploy.flags.includes('--dry-run'));
 assert.ok(!first.verbs.deploy.flags.includes('--host'));
 assert.ok(first.verbs.demo.effects.length > 0, 'rer demo is listed as a verb with its effects');
 assert.ok(first.verbs.demo.flags.includes('--port') && !first.verbs.demo.flags.includes('--demo') && !first.verbs.demo.flags.includes('--door'), 'the demo verb lists the dev flags a demo takes');
 assert.ok(first.verbs.preview.effects.length > 0, 'the shared effect remains a final fallback when the seed has no declaration');

 descriptor.commands.deploy.effects = 'Hosted deployment is held until release approval.';
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify(descriptor));
 const changed = describe();
 assert.equal(changed.verbs.deploy.effects, descriptor.commands.deploy.effects);
 await assert.rejects(access(join(root, 'hook-ran')), { code: 'ENOENT' });
});

// A person reading the default seed's describe learns every release subcommand.
test('the default seed describes its release subcommands', () => {
 const result = spawnSync(process.execPath, [cli, 'describe', '--json', '--cwd', fileURLToPath(new URL('../default-seed', import.meta.url))], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
 assert.equal(result.status, 0, result.stderr);
 const { effects } = JSON.parse(result.stdout.trim().split('\n').at(-1)).verbs.release;
 for (const subcommand of ['keygen', 'sign', 'receipt']) assert.match(effects, new RegExp(`\\b${subcommand}\\b`), effects);
});
