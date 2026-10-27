import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateManagedWorkflow} from '../generators/managed.mjs';
import {produceArtifact} from '../artifact.mjs';
import {exportProducer} from '../export.mjs';
import {packaging} from '../cli.mjs';
import {packagingConfig, producePackage} from '../package.mjs';

const packageRoot = fileURLToPath(new URL('../../../../tmp/', import.meta.url));
const examplePath = new URL('../../../schema/SETUP.example.json', import.meta.url);
const workflowRef = `publisher/delivery/.github/workflows/trusted-build.yml@${'a'.repeat(40)}`;

function config(setup) {
  return {
    schema: 1,
    project: {
      schema: 1,
      projectId: 'publisher/app',
      name: 'App',
      sourceRepository: 'https://github.com/octocat/Hello-World',
      license: 'MIT',
      deployment: {target: 'cloudflare-workers', artifactFile: 'app.json'},
      operations: {
        build: 'make build',
        verify: 'make verify',
        artifact: 'node scripts/delivery/base/cli.mjs artifact --config scripts/delivery/base/packaging.json',
        recovery: 'Restore retained data.'
      }
    },
    managed: {workflowRef, artifactFile: 'app.json', buildProfile: 'project', verificationProfiles: ['full']},
    artifact: {
      specInputs: {
        recovery: 'Restore retained data.',
        providerEffects: ['outbound-mail'],
        surfaces: {app: {path: '/', originVariable: 'APP_ORIGIN'}},
        initialSetup: {path: '/setup-status', pendingStatus: 409, completeStatus: 200}
      }
    },
    ...(setup === undefined ? {} : {setup})
  };
}

async function fixture(t, {withManifest = true} = {}) {
  await mkdir(packageRoot, {recursive: true});
  const root = await mkdtemp(join(packageRoot, 'base-setup-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'dist/server'), {recursive: true});
  await mkdir(join(root, 'dist/client'), {recursive: true});
  await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({compatibility_date: '2026-09-08'}));
  await writeFile(join(root, 'dist/server/index.js'), 'export default {};\n');
  await writeFile(join(root, 'dist/client/index.html'), '<main>App</main>\n');
  if (withManifest) await writeFile(join(root, 'setup.json'), await readFile(examplePath));
  return root;
}

async function filesUnder(directory, prefix = '') {
  const entries = {};
  for (const name of (await readdir(join(directory, prefix), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) Object.assign(entries, await filesUnder(directory, path));
    else entries[path] = await readFile(join(directory, path));
  }
  return entries;
}

test("setup manifest packaging preserves canonical bytes and refuses invalid or unsafe selection", async t => {
  const step = namedSteps(t);
  await step('setup manifest is validated and emitted as deterministic sibling bytes with a matching descriptor digest', async t => {
    const root = await fixture(t);
    const policy = config({manifestFile: 'setup.json'});
    const first = await producePackage({root, config: policy, output: 'with-setup'});
    const input = JSON.parse(await readFile(join(root, 'setup.json'), 'utf8'));
    const setupBytes = await readFile(first.setup);
    assert.deepEqual(setupBytes, Buffer.from(`${JSON.stringify(input, null, 2)}\n`));
    assert.equal(first.setup, join(root, 'with-setup/rer-setup.json'));
  
    const descriptorBytes = await readFile(first.project);
    const descriptor = JSON.parse(descriptorBytes);
    assert.deepEqual(descriptor.setup, {
      path: 'rer-setup.json',
      sha256: createHash('sha256').update(setupBytes).digest('hex')
    });
    assert.equal(descriptor.schema, 1);
  
    const second = await producePackage({root, config: policy, output: 'with-setup-again'});
    assert.deepEqual(await readFile(second.setup), setupBytes);
    assert.deepEqual(await readFile(second.project), descriptorBytes);
  });
  
  await step('no-manifest packaging keeps the prior descriptor shape and adds no setup output', async t => {
    const root = await fixture(t);
    const policy = config();
    const result = await producePackage({root, config: policy, output: 'without-setup'});
    assert.deepEqual(await readFile(result.project), Buffer.from(`${JSON.stringify(policy.project, null, 2)}\n`));
    assert.deepEqual(await readFile(result.workflow), Buffer.from(generateManagedWorkflow(policy.managed)));
    await produceArtifact({
      ...policy.artifact,
      root,
      output: 'without-setup-reference/delivery-artifact/app.json'
    });
    assert.deepEqual(
      await filesUnder(join(root, 'without-setup/delivery-artifact')),
      await filesUnder(join(root, 'without-setup-reference/delivery-artifact'))
    );
    assert.equal(result.setup, undefined);
    assert.deepEqual(Object.keys(await filesUnder(join(root, 'without-setup'))).sort(), [
      '.github/workflows/rer-managed.yml',
      'delivery-artifact/app.json',
      'delivery-artifact/payload/assets/000000',
      'delivery-artifact/payload/modules/000000',
      'rer-project.json'
    ]);
    await assert.rejects(readFile(join(root, 'without-setup/rer-setup.json')));
  });
  
  await step('unsafe, missing, malformed and symlink setup manifests fail without a partial package', async t => {
    const root = await fixture(t);
    const policy = config();
    for (const selection of [
      {manifestFile: '../setup.json'},
      {manifestFile: '/setup.json'},
      {manifestFile: 'setup.yaml'},
      {manifestFile: 'setup.json', extra: true}
    ]) assert.throws(() => packagingConfig({...policy, setup: selection}));
  
    for (const [name, setup, expected] of [
      ['missing', {manifestFile: 'missing.json'}, /ENOENT/],
      ['invalid-json', {manifestFile: 'invalid.json'}, /valid JSON/],
      ['invalid-schema', {manifestFile: 'invalid-schema.json'}, /Invalid setup manifest/]
    ]) {
      if (name === 'invalid-json') await writeFile(join(root, 'invalid.json'), '{');
      if (name === 'invalid-schema') await writeFile(join(root, 'invalid-schema.json'), '{"schema":1,"title":"x","groups":[],"fields":[],"steps":[]}');
      await assert.rejects(producePackage({root, config: config(setup), output: `rejected-${name}`}), expected);
      await assert.rejects(readdir(join(root, `rejected-${name}`)));
    }
  
    await symlink(join(root, 'setup.json'), join(root, 'linked.json'));
    await assert.rejects(producePackage({root, config: config({manifestFile: 'linked.json'}), output: 'rejected-symlink'}), /symlink refused/);
    await assert.rejects(readdir(join(root, 'rejected-symlink')));
  });
  
  await step('semantic-invalid and duplicate-key manifests fail before artifact-only output', async t => {
    const root = await fixture(t);
    const invalid = JSON.parse(await readFile(join(root, 'setup.json'), 'utf8'));
    invalid.fields[1].name = invalid.fields[0].name;
    await writeFile(join(root, 'setup.json'), `${JSON.stringify(invalid)}\n`);
    await writeFile(join(root, 'rer-packaging.json'), JSON.stringify(config({manifestFile: 'setup.json'})));
    await assert.rejects(packaging(['artifact', '--root', root, '--config', 'rer-packaging.json']), /Invalid setup manifest/);
    await assert.rejects(readFile(join(root, 'delivery-artifact/app.json')));
  
    await writeFile(join(root, 'setup.json'), '{"schema":1,"schema":1}');
    await assert.rejects(packaging(['artifact', '--root', root, '--config', 'rer-packaging.json']), /duplicate JSON field/);
    await assert.rejects(readFile(join(root, 'delivery-artifact/app.json')));
  
    await assert.rejects(exportProducer({root, config: config({manifestFile: 'setup.json'}), output: 'rejected-export'}), /duplicate JSON field/);
    await assert.rejects(readdir(join(root, 'rejected-export')));
  });
  
  await step('export vendors the setup schema and validators and its artifact command validates selected manifests', async t => {
    const root = await fixture(t);
    const policy = config({manifestFile: 'setup.json'});
    const exported = await exportProducer({root, config: policy});
    for (const name of ['SETUP.schema.json', 'json-schema.mjs', 'setup-validation.mjs']) {
      assert.deepEqual(
        await readFile(join(exported, 'schema', name)),
        await readFile(new URL(`../../../schema/${name}`, import.meta.url))
      );
    }
    execFileSync(process.execPath, [join(exported, 'cli.mjs'), 'artifact', '--root', root, '--config', 'scripts/delivery/base/packaging.json'], {cwd: root, stdio: 'pipe'});
    const artifact = JSON.parse(await readFile(join(root, 'delivery-artifact/app.json'), 'utf8'));
    assert.equal(artifact.schema, 2);
  });
})









