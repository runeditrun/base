import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {packaging} from '../cli.mjs';
import {generateMailSetupFields} from '../mail.mjs';
import {createInstallerModel} from '../../../onboarding/setup-manifest.mjs';

const mail = {providers: ['rer', 'resend', 'sendgrid', 'cloudflare']};
const publicVariables = {MAIL_PROVIDER: '', MAIL_FROM: '', MAIL_RELAY_URL: ''};
const setup = (declaration = mail) => ({schema: 1, title: 'Mail app', groups: [], fields: generateMailSetupFields(declaration), steps: [{type: 'extension', id: 'application'}]});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'managed-mail-producer-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'dist/server'), {recursive: true});
  await mkdir(join(root, 'dist/client'), {recursive: true});
  await writeFile(join(root, 'dist/server/index.js'), 'export default {};\n');
  await writeFile(join(root, 'dist/client/index.html'), '<main>App</main>\n');
  const config = {
    schema: 1,
    project: {schema: 1, projectId: 'publisher/app', name: 'App', sourceRepository: 'https://github.com/octocat/Hello-World',
      license: 'MIT', deployment: {target: 'cloudflare-workers', artifactFile: 'app.json'},
      operations: {build: 'make build', verify: 'make verify', artifact: 'make artifact', recovery: 'Restore retained data.'}},
    managed: {workflowRef: `publisher/delivery/.github/workflows/trusted-build.yml@${'a'.repeat(40)}`,
      artifactFile: 'app.json', buildProfile: 'project', verificationProfiles: ['full']},
    setup: {manifestFile: 'rer-setup.json'},
    artifact: {specInputs: {mail, publicVariableNames: Object.keys(publicVariables), optionalSecretNames: ['MAIL_API_KEY'], recovery: 'Restore retained data.'}}
  };
  const save = async (manifest = setup(), vars = publicVariables) => {
    await writeFile(join(root, 'rer-setup.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(root, 'rer-packaging.json'), JSON.stringify(config));
    await writeFile(join(root, 'dist/server/wrangler.json'), JSON.stringify({compatibility_date: '2026-09-08', vars}));
  };
  await save();
  const run = (command, output) => packaging([command, '--root', root, '--config', 'rer-packaging.json', '--output', output]);
  return {root, config, save, run};
}

test("managed-mail packaging binds provider setup to declared public fields and private credentials", async t => {
  const step = namedSteps(t);
  await step('generated mail setup and spec survive packaging and the independent exported producer', async t => {
    const {root, config, save, run} = await fixture(t);
    for (const required of [false, true]) {
      config.artifact.specInputs.secretNames = required ? ['MAIL_API_KEY'] : [];
      config.artifact.specInputs.optionalSecretNames = required ? [] : ['MAIL_API_KEY'];
      await save();
      const result = await run('package', `package-${required}`);
      const artifact = JSON.parse(await readFile(result.artifact));
      assert.deepEqual(artifact.deploymentSpec.mail, mail);
      assert.deepEqual(artifact.deploymentSpec.publicVariables, publicVariables);
      const manifest = JSON.parse(await readFile(result.setup));
      const model = createInstallerModel(manifest);
      assert.throws(() => model.validateInput({MAIL_PROVIDER: 'rer', MAIL_FROM: 'App <sender@example.test>', MAIL_RELAY_URL: 'https://app.example.test/api/managed-mail/send'}), /MAIL_API_KEY/);
      for (const provider of mail.providers) {
        const values = {MAIL_PROVIDER: provider, MAIL_FROM: 'sender@example.test', MAIL_API_KEY: 'test-only-credential',
          ...(provider === 'rer' ? {MAIL_RELAY_URL: 'https://app.example.test/api/managed-mail/send'} : {}),
          ...(provider === 'cloudflare' ? {MAIL_ACCOUNT_ID: 'a'.repeat(32)} : {})};
        assert.doesNotThrow(() => model.validateInput(values));
      }
    }
    config.artifact.specInputs.mail = {providers: ['rer']};
    await save(setup(config.artifact.specInputs.mail));
    const exported = await run('export', 'portable');
    execFileSync(process.execPath, [join(exported, 'cli.mjs'), 'artifact', '--root', root, '--config', 'portable/packaging.json'], {stdio: 'pipe'});
    const artifact = JSON.parse(await readFile(join(root, 'delivery-artifact/app.json')));
    assert.deepEqual(artifact.deploymentSpec.mail, {providers: ['rer']});
  });
  
  await step('managed mail refuses missing or public credentials and undeclared public bindings before artifact output', async t => {
    const {root, config, save, run} = await fixture(t);
    for (const name of Object.keys(publicVariables)) {
      const vars = {...publicVariables}; delete vars[name];
      await save(setup(), vars);
      await assert.rejects(run('artifact', `missing-${name}/app.json`), new RegExp(name));
      await assert.rejects(readFile(join(root, `missing-${name}/app.json`)));
    }
    config.artifact.specInputs.optionalSecretNames = [];
    await save();
    await assert.rejects(run('artifact', 'missing-key/app.json'), /secret MAIL_API_KEY/);
    config.artifact.specInputs.publicVariableNames.push('MAIL_API_KEY');
    await save(setup(), {...publicVariables, MAIL_API_KEY: 'public-is-invalid'});
    await assert.rejects(run('artifact', 'public-key/app.json'), /secret MAIL_API_KEY/);
    for (const declaration of [{providers: []}, {providers: ['rer', 'rer']}, {providers: ['unknown']}, {providers: ['rer'], extra: true}]) {
      config.artifact.specInputs.mail = declaration;
      await save();
      await assert.rejects(run('artifact', 'bad-declaration/app.json'));
    }
  });
  
  await step('package and artifact commands reject setup fields that cannot supply required managed mail inputs', async t => {
    const {root, save, run} = await fixture(t);
    const mutations = [
      m => { m.fields = m.fields.filter(field => field.name !== 'MAIL_RELAY_URL'); },
      m => { m.fields[0].options = m.fields[0].options.filter(option => option.value !== 'rer'); },
      m => { m.fields.find(field => field.name === 'MAIL_API_KEY').presentations[0].required = false; },
      m => { m.fields.find(field => field.name === 'MAIL_API_KEY').presentations.shift(); },
      m => { m.fields.find(field => field.name === 'MAIL_RELAY_URL').required = false; },
      m => { m.fields.find(field => field.name === 'MAIL_RELAY_URL').when.equals = 'resend'; }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const manifest = setup(); mutate(manifest); await save(manifest);
      await assert.rejects(run('package', `invalid-${index}`), /mail|MAIL_|condition/i);
      await assert.rejects(run('artifact', `invalid-artifact-${index}/app.json`), /mail|MAIL_|condition/i);
      await assert.rejects(readFile(join(root, `invalid-${index}/rer-project.json`)));
    }
  });
})





