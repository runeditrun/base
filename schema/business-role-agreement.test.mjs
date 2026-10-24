import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateSetupManifest} from './setup-validation.mjs';
import {loadInstallerSeed} from '../onboarding/setup-manifest.mjs';
import {loadInstallerSeed as loadShippedInstallerSeed} from '../default-seed/scripts/base-onboarding/setup-manifest.mjs';

test('setup CLI, both installer loaders and Business runtime admit the same native team roles', async t => {
  const generated = spawnSync(process.execPath, [new URL('./generate-business-role.mjs', import.meta.url).pathname, '--check'], {encoding: 'utf8'});
  assert.equal(generated.status, 0, generated.stderr);
  const schema = JSON.parse(await readFile(new URL('./SETUP.schema.json', import.meta.url)));
  const destination = await mkdtemp(join(tmpdir(), 'business-roles-'));
  t.after(() => rm(destination, {recursive: true, force: true}));
  const base = {
    schema: 1, title: 'Team settings', groups: [],
    fields: [{name: 'WORKSPACE_TITLE', label: 'Workspace', kind: 'text'}],
    steps: [{type: 'extension', id: 'workspace'}],
    business: {settings: 1, values: ['display_name'], team: {roles: {admin: 'admin', member: 'member'}}},
  };
  const samples = [
    ['admin', true], ['team lead', true], ['管理者', true], ['a'.repeat(64), true],
    ['😀'.repeat(32), true], ['team\u2028lead', true],
    [' admin ', false], ['\u00a0admin', false], ['admin\ufeff', false],
    ['a'.repeat(65), false], ['😀'.repeat(33), false], ['ad\u0000min', false],
    ['ad\u001fmin', false], ['ad\u007fmin', false], ['ad\u009fmin', false],
    ['admin\n', false], ['owner', false], ['OwNeR', false], [' owner ', false],
    ['', false], [' ', false], [null, false], [7, false],
  ];
  const candidates = [];
  for (const name of ['admin', 'member']) for (const [role, accepted] of samples) {
    const manifest = structuredClone(base);
    manifest.business.team.roles[name] = role;
    candidates.push({manifest, accepted});
  }
  // Exercise the public constructor without a database: admission performs no IO.
  const runtime = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import {readFileSync} from 'node:fs';
    const {createBusinessSettings} = await import(${JSON.stringify(new URL('../modules/business-settings/index.ts', import.meta.url).href)});
    const rows = JSON.parse(readFileSync(0, 'utf8')).map(({manifest}) => {
      try { createBusinessSettings({business: manifest.business}); return true; }
      catch (error) { if (error.code !== 'invalid_settings') throw error; return false; }
    });
    console.log(JSON.stringify(rows));
  `], {encoding: 'utf8', input: JSON.stringify(candidates)});
  assert.equal(runtime.status, 0, runtime.stderr);
  const runtimeResults = JSON.parse(runtime.stdout);
  for (const [index, {manifest, accepted}] of candidates.entries()) {
    const label = JSON.stringify(manifest.business.team.roles);
    assert.equal(runtimeResults[index], accepted, `runtime: ${label}`);
    assert.equal(validateSetupManifest(schema, manifest).length === 0, accepted, `schema: ${label}`);
    const file = join(destination, 'rer-setup.json');
    await writeFile(file, JSON.stringify(manifest));
    const cli = spawnSync(process.execPath, [new URL('./validate.mjs', import.meta.url).pathname, '--schema', 'SETUP', file], {encoding: 'utf8'});
    assert.equal(cli.status, accepted ? 0 : 1, `CLI: ${label}\n${cli.stderr}`);
    for (const load of [loadInstallerSeed, loadShippedInstallerSeed]) {
      const installation = load(destination, {product: 'Team settings', setup: {manifestFile: 'rer-setup.json'}});
      if (accepted) await installation;
      else await assert.rejects(installation, `installer: ${label}`);
    }
  }
});
