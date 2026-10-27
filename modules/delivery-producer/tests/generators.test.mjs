import { namedSteps } from '../../review-harness/tests/fold-steps.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';
import {generateProjectDescriptor} from '../generators/project.mjs';
import {generateManagedWorkflow} from '../generators/managed.mjs';
import {generateIntegrationBundle} from '../generators/integration.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const pin = '0123456789abcdef0123456789abcdef01234567';
const workflowRef = `maintainer/builds/.github/workflows/trusted-build.yml@${pin}`;
const descriptor = () => ({schema: 1, projectId: 'independent/application', name: 'Application', sourceRepository: 'https://github.com/octocat/Hello-World', license: 'MIT', deployment: {target: 'cloudflare-workers', artifactFile: 'app.json'}, operations: {setup: 'make dependencies', build: 'make build', verify: 'make check', artifact: 'make package', recovery: 'Restore the retained source and application data.'}});

async function fixture(t) {
  const root = await mkdtemp(join(testRoot, '.generator-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const git = args => execFileSync('git', ['-C', projectRoot, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git(['init', '-q']);
  const put = async (path, bytes) => {await mkdir(dirname(join(projectRoot, path)), {recursive: true}); await writeFile(join(projectRoot, path), bytes);};
  const commit = () => {git(['add', '--all']); git(['-c', 'user.name=Generator Test', '-c', 'user.email=generator@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Integration source']); return git(['rev-parse', 'HEAD']);};
  return {root, projectRoot, git, put, commit, output: join(root, 'bundle')};
}

test("descriptor generation preserves identity and verification across valid and refused inputs", async t => {
  const step = namedSteps(t);
  await step('source descriptor preserves independent identity and exact existing verification policy', () => {
    const input = descriptor();
    input.name = ' Application ';
    input.verification = {testPatterns: ['**/*.test.*', '**/*.test.*'], sensitivePaths: ['src/auth/**'], migrationDirectories: ['data/migrations/'], guidanceFiles: []};
    const result = generateProjectDescriptor(input);
    assert.equal(result.name, 'Application');
    assert.equal(result.sourceRepository, 'https://github.com/octocat/Hello-World');
    assert.deepEqual(result.verification, input.verification);
    assert.notEqual(result.verification.sensitivePaths, input.verification.sensitivePaths);
    assert.equal(Object.hasOwn(result, 'revision'), false);
    assert.deepEqual(generateProjectDescriptor(result), result);
    delete input.deployment.artifactFile;
    assert.equal(generateProjectDescriptor(input).deployment.artifactFile, 'rer-worker-artifact.json');
  });
  
  await step('versioned optional visual permission never replaces required full verification', () => {
    const input = descriptor();
    assert.equal(Object.hasOwn(generateProjectDescriptor(input).operations, 'verificationProfiles'), false);
    input.operations.verificationProfiles = {schema: 1};
    assert.deepEqual(generateProjectDescriptor(input).operations.verificationProfiles, {schema: 1});
    input.operations.verificationProfiles.visual = {command: '  make visual  '};
    const result = generateProjectDescriptor(input);
    assert.equal(result.operations.verify, 'make check');
    assert.deepEqual(result.operations.verificationProfiles, {schema: 1, visual: {command: 'make visual'}});
    input.operations.verificationProfiles.visual.command = 'x'.repeat(2000);
    assert.equal(generateProjectDescriptor(input).operations.verificationProfiles.visual.command.length, 2000);
    delete input.operations.verify;
    assert.throws(() => generateProjectDescriptor(input), /operations.verify/);
  });
  
  await step('descriptor rejects unagreed shape, self-referential identity and malformed permissions', () => {
    for (const bad of [null, [], true, {}, {schema: 2}, {schema: '1'}, {schema: 1, fast: {}}, {schema: 1, visual: true}, {schema: 1, visual: []}, {schema: 1, visual: null}, {schema: 1, visual: {}}, {schema: 1, visual: {command: ''}}, {schema: 1, visual: {command: ' '.repeat(2)}}, {schema: 1, visual: {command: 'x'.repeat(2001)}}, {schema: 1, visual: {command: 'make visual', enabled: true}}, {schema: 1, visual: undefined}]) {
      const input = descriptor(); input.operations.verificationProfiles = bad;
      assert.throws(() => generateProjectDescriptor(input), Error, JSON.stringify(bad));
    }
    for (const field of ['revision', 'sourceRevision', 'edition', 'other']) assert.throws(() => generateProjectDescriptor({...descriptor(), [field]: pin}), /Unknown/);
    const input = descriptor(); input.operations.command = 'make anything';
    assert.throws(() => generateProjectDescriptor(input), /Unknown/);
    for (const bad of [{other: []}, {guidanceFiles: '../private'}, {testPatterns: ['../private']}, {migrationDirectories: ['/absolute']}, {sensitivePaths: ['x'.repeat(301)]}, {guidanceFiles: Array(201).fill('safe')}]) assert.throws(() => generateProjectDescriptor({...descriptor(), verification: bad}));
    for (const value of [[], null, new Date(), Object.create({schema: 1})]) assert.throws(() => generateProjectDescriptor(value));
    const accessor = descriptor(); Object.defineProperty(accessor, 'name', {get() {throw new Error('Accessor executed');}});
    assert.throws(() => generateProjectDescriptor(accessor), /data fields only/);
  });
})






test("managed caller generation preserves its ABI and refuses unsafe input", async t => {
  const step = namedSteps(t);
  await step('caller uses existing immutable ABI, full default and only fixed expressions', () => {
    const generated = generateManagedWorkflow({workflowRef, artifactFile: 'app.json'});
    assert.equal(generated, generateManagedWorkflow({workflowRef, artifactFile: 'app.json'}));
    assert.match(generated, new RegExp(`uses: '${workflowRef.replaceAll('.', '\\.')}'`));
    assert.match(generated, /default: full/);
    assert.match(generated, /options: \[full, visual\]/);
    assert.match(generated, /build_profile: 'project'/);
    assert.match(generated, /artifact_file: 'app.json'/);
    assert.deepEqual([...generated.matchAll(/\$\{\{ (.*?) \}\}/g)].map(match => match[1]), ['inputs.installation_id', 'inputs.broker_url', 'inputs.environment', 'inputs.verification_profile']);
    assert.doesNotMatch(generated, /secrets:|run:|verification_command|pnpm_version:/);
    const edition = generateManagedWorkflow({workflowRef, artifactFile: 'app.json', buildProfile: 'edition', pnpmVersion: '10.12.4'});
    assert.match(edition, /build_profile: 'edition'/);
    assert.match(edition, /pnpm_version: '10.12.4'/);
  });
  
  await step('caller rejects mutable refs, unsafe YAML or Actions interpolation and unknown inputs', () => {
    const good = {workflowRef, artifactFile: 'app.json'};
    for (const bad of ['main', 'v1', pin.slice(0, 7), pin.toUpperCase(), `${pin}\nname: injected`, '${{ github.sha }}']) assert.throws(() => generateManagedWorkflow({...good, workflowRef: `owner/repo/.github/workflows/trusted-build.yml@${bad}`}));
    for (const bad of ['../app.json', 'delivery-artifact/app.json', 'release-provenance.json', '${{ secrets.DEPLOY }}.json', "app'\nsecrets: inherit\n#.json", 'app..json']) assert.throws(() => generateManagedWorkflow({...good, artifactFile: bad}));
    for (const bad of ['fast', 'project\nrun: evil', '${{ inputs.profile }}']) assert.throws(() => generateManagedWorkflow({...good, buildProfile: bad}));
    for (const bad of ['latest', '11.0.0', '8.15.6\nsecrets: inherit']) assert.throws(() => generateManagedWorkflow({...good, pnpmVersion: bad}));
    assert.throws(() => generateManagedWorkflow({...good, verification_command: 'echo unsafe'}), /Unknown/);
  });
})




test("integration bundle preserves committed bytes and refuses unsafe source or output", async t => {
  const step = namedSteps(t);
  await step('bundle retains exact committed bytes, identity and current adoption contract despite dirty source', async t => {
    const f = await fixture(t);
    const bytes = Buffer.from([0, 1, 13, 10, 255]);
    await f.put('management/integration/nested/data.bin', bytes);
    await f.put('management/integration/index.ts', 'export const profile = {};\r\n');
    const revision = f.commit();
    await f.put('management/integration/index.ts', 'dirty source');
    await f.put('management/integration/untracked.ts', 'untracked source');
    const result = await generateIntegrationBundle({...{projectRoot: f.projectRoot, output: f.output}, repository: 'octocat/Hello-World', revision});
    assert.deepEqual(Object.keys(result), ['schema', 'repository', 'revision', 'sourcePath', 'files']);
    assert.equal(result.revision, revision);
    assert.deepEqual(result.files.map(file => file.path), ['index.ts', 'nested/data.bin']);
    assert.deepEqual(await readFile(join(f.output, 'nested/data.bin')), bytes);
    assert.equal(await readFile(join(f.output, 'index.ts'), 'utf8'), 'export const profile = {};\r\n');
    for (const file of result.files) {
      const payload = await readFile(join(f.output, file.path));
      assert.deepEqual(Object.keys(file), ['path', 'sourcePath', 'sha256', 'size']);
      assert.equal(file.sourcePath, `management/integration/${file.path}`);
      assert.equal(file.sha256, createHash('sha256').update(payload).digest('hex'));
      assert.equal(file.size, payload.length);
    }
    assert.deepEqual(JSON.parse(await readFile(join(f.output, 'adoption.json'), 'utf8')), result);
    const second = join(f.root, 'second bundle');
    await generateIntegrationBundle({projectRoot: f.projectRoot, output: second, repository: 'octocat/Hello-World', revision});
    assert.deepEqual(await readFile(join(second, 'adoption.json')), await readFile(join(f.output, 'adoption.json')));
    await assert.rejects(generateIntegrationBundle({projectRoot: f.projectRoot, output: f.output, repository: 'octocat/Hello-World', revision}), /fresh/);
    assert.equal(await readFile(join(f.projectRoot, 'management/integration/index.ts'), 'utf8'), 'dirty source');
  });
  
  await step('bundle reads older full revision, supports explicit source path and ignores Git replacement objects', async t => {
    const f = await fixture(t);
    await f.put('adapters/custom/index.ts', 'old source'); const revision = f.commit();
    await f.put('adapters/custom/index.ts', 'new source'); const newer = f.commit();
    f.git(['replace', revision, newer]);
    const manifest = await generateIntegrationBundle({projectRoot: f.projectRoot, output: f.output, sourcePath: 'adapters/custom', repository: 'octocat/Hello-World', revision});
    assert.equal(manifest.sourcePath, 'adapters/custom');
    assert.equal(await readFile(join(f.output, 'index.ts'), 'utf8'), 'old source');
  });
  
  await step('bundle rejects private, reserved and symlink blobs before creating output', async t => {
    for (const name of ['.env', '.env.example', 'nested/.dev.vars', '.npmrc', 'credentials.json', 'secrets.json', 'private.key', 'adoption.json']) {
      const f = await fixture(t);
      await f.put(`management/integration/${name}`, 'test-only private marker'); const revision = f.commit();
      await assert.rejects(generateIntegrationBundle({projectRoot: f.projectRoot, output: f.output, repository: 'octocat/Hello-World', revision}), /Private|reserved/);
      await assert.rejects(lstat(f.output), {code: 'ENOENT'});
    }
    const f = await fixture(t);
    await f.put('management/integration/index.ts', 'source');
    await symlink('index.ts', join(f.projectRoot, 'management/integration/link.ts'));
    const revision = f.commit();
    await assert.rejects(generateIntegrationBundle({projectRoot: f.projectRoot, output: f.output, repository: 'octocat/Hello-World', revision}), /symlink/);
  });
  
  await step('bundle rejects path escapes, mutable/mismatched identities, source overwrite and unsafe output ancestors', async t => {
    const f = await fixture(t);
    await f.put('management/integration/index.ts', 'source'); const revision = f.commit();
    const good = {projectRoot: f.projectRoot, output: f.output, repository: 'octocat/Hello-World', revision};
    for (const sourcePath of ['../outside', '/absolute', 'management//integration', 'management/./integration', 'management\\integration', 'management/integration/index.ts', 'missing', '.git']) await assert.rejects(generateIntegrationBundle({...good, sourcePath}));
    for (const value of ['HEAD', 'main', revision.slice(0, 7), revision.toUpperCase(), '0'.repeat(40)]) await assert.rejects(generateIntegrationBundle({...good, revision: value}));
    for (const repository of ['owner', '../repo', 'https://example.invalid/owner/repo']) {
      await assert.rejects(generateIntegrationBundle({...good, repository}));
    }
    for (const output of [join(f.projectRoot, 'management/integration/new'), `${f.root}/../escape`, join(f.projectRoot, '.git/new'), join(f.root, '.env')]) await assert.rejects(generateIntegrationBundle({...good, output}));
    await mkdir(join(f.root, 'real'));
    await symlink(join(f.root, 'real'), join(f.root, 'link'));
    await assert.rejects(generateIntegrationBundle({...good, output: join(f.root, 'link', 'bundle')}), /symlinks/);
    await symlink(join(f.root, 'real'), f.output);
    await assert.rejects(generateIntegrationBundle(good), /fresh/);
    assert.equal(await readFile(join(f.projectRoot, 'management/integration/index.ts'), 'utf8'), 'source');
  });
  
  await step('bundle rejects submodule entries and duplicate case-folded paths in committed trees', async t => {
    const f = await fixture(t);
    await f.put('management/integration/index.ts', 'source'); const original = f.commit();
    f.git(['update-index', '--add', '--cacheinfo', `160000,${original},management/integration/submodule`]);
    f.git(['-c', 'user.name=Generator Test', '-c', 'user.email=generator@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Submodule tree']);
    await assert.rejects(generateIntegrationBundle({projectRoot: f.projectRoot, output: f.output, repository: 'octocat/Hello-World', revision: f.git(['rev-parse', 'HEAD'])}), /unsupported Git entry/);
    f.git(['update-index', '--force-remove', 'management/integration/submodule']);
    const blob = f.git(['rev-parse', `${original}:management/integration/index.ts`]);
    for (const path of ['management/integration/Case.ts', 'management/integration/case.ts']) f.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    f.git(['-c', 'user.name=Generator Test', '-c', 'user.email=generator@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Case-fold collision']);
    await assert.rejects(generateIntegrationBundle({projectRoot: f.projectRoot, output: f.output, repository: 'octocat/Hello-World', revision: f.git(['rev-parse', 'HEAD'])}), /Duplicate/);
    await assert.rejects(lstat(f.output), {code: 'ENOENT'});
  });
})









