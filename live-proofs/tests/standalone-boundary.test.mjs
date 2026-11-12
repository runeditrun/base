import { runRows } from '../../default-seed/tests/rows.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { standaloneFixture } from './standalone-fixture.mjs';
import { snapshotSource, reviewDescriptor, copyControllerFiles, credentialNames } from '../standalone/review.mjs';
import { reviewedExecutor } from '../standalone/executor.mjs';
import { Containers } from '../t016/isolation.mjs';
import { digest, deployDescriptor } from '../../scripts/qualification/operations.mjs';
import { runStandalone } from '../standalone/run.mjs';

const executorRows = []
const authorityRows = []

function scratch(t) {
  assert(process.env.T016_TEST_TMP); const root = mkdtempSync(join(process.env.T016_TEST_TMP, 'generic-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function archive() {
  const bytes = Buffer.from('actual-build'), h = Buffer.alloc(512);
  h.write('payload.txt'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write('0', 156);
  h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, bytes, Buffer.alloc(512 - bytes.length), Buffer.alloc(1024)]);
}
const images = { controller: 'sha256:' + '1'.repeat(64), build: 'sha256:' + '2'.repeat(64), browser: 'sha256:' + '3'.repeat(64) };
const result = (exitCode = 0, output = '') => ({ exitCode, output: Buffer.from(output), outputHash: digest(output), startedUtc: new Date().toISOString(), finishedUtc: new Date().toISOString() });
async function brokerRequest(root) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: join(root, 'broker/build.sock'), path: '/build/0', method: 'POST' }, response => {
      let text = ''; response.on('data', data => text += data); response.on('end', () => resolve(JSON.parse(text).exitCode));
    }); req.on('error', reject); req.end();
  });
}
authorityRows.push(['committed snapshot excludes ignored credentials and mutable checkout files', {}, async t => {
  const root = scratch(t), f = standaloneFixture(root), destination = join(root, 'snapshot');
  const original = readFileSync(join(f.directory, 'product/build.mjs'), 'utf8');
  writeFileSync(join(f.directory, 'product/build.mjs'), 'throw new Error("dirty-checkout-must-not-run");');
  await snapshotSource({ ...f, sourceSha: f.adapter.sourceSha, destination });
  assert(!existsSync(join(destination, 'private.env'))); assert(!existsSync(join(destination, '.git')));
  assert.equal(readFileSync(join(destination, 'product/build.mjs'), 'utf8'), original);
  assert.throws(() => copyControllerFiles(destination, join(root, 'bad'), { 'product/setup.mjs': 'f'.repeat(64) }), /controller-file-mismatch/);
  await assert.rejects(snapshotSource({ ...f, sourceSha: 'a'.repeat(40), destination: join(root, 'other') }), /revision-mismatch/);
}]);
authorityRows.push(['review admits declared credentials and exact literal shell/cwd, rejects changed contracts', {}, t => {
  const f = standaloneFixture(scratch(t)); const review = reviewDescriptor(f.descriptor, f.adapter);
  assert.deepEqual(review.names, ['PROVIDER_TOKEN']); assert.deepEqual(review.commands[1].argv, f.descriptor.commands.deploy.argv);
  assert.equal(review.commands[1].cwd, 'product');
  for (const name of ['EVIDENCE_WRITE_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'PATH', 'HOME', 'BASH_ENV', 'LD_PRELOAD']) assert.throws(() => credentialNames([name]));
  assert.throws(() => reviewDescriptor({ ...f.descriptor, requiredEnvironment: ['OTHER_TOKEN'] }, f.adapter), /unreviewed-descriptor/);
  assert.throws(() => reviewDescriptor(f.descriptor, { ...f.adapter, requiredEnvironment: [] }), /unreviewed-credentials/);
  const descriptor = structuredClone(f.descriptor); descriptor.commands.deploy.cwd = '../outside';
  assert.throws(() => reviewDescriptor(descriptor, { ...f.adapter, descriptorSha256: digest(descriptor) }), /unsafe-source-path/);
  assert.throws(() => reviewDescriptor(f.descriptor, { ...f.adapter, builds: [{ ...f.adapter.builds[0], output: 'product' }] }), /artifact-controller-overlap/);
  assert.throws(() => reviewDescriptor(f.descriptor, { ...f.adapter, builds: [{ ...f.adapter.builds[0], publicEnvironment: ['PROVIDER_TOKEN'] }] }), /unreviewed-public-environment/);
}]);
authorityRows.push(['legacy local command helper cannot bypass the reviewed credential route', {}, t => {
  const f = standaloneFixture(scratch(t));
  assert.throws(() => deployDescriptor({ cwd: f.directory, env: { PATH: process.env.PATH, PROVIDER_TOKEN: 'test-only' } }), /reviewed-executor-required/);
  assert(!existsSync(join(f.directory, 'product/prepared.json')));
}]);
for (const fault of [undefined, 'install', 'build', 'ignored-build-failure', 'artifact']) executorRows.push(['reviewed executor routes real argv through isolated boundary: ' + (fault ?? 'success'), {}, async t => {
  const root = scratch(t), f = standaloneFixture(root), work = join(root, 'work'); mkdirSync(work);
  const calls = [], creates = [], observations = []; let next = 1;
  // Docker protocol fixtures are local to this test; production has no substitute
  // executor or environment switch that can turn off the Linux boundary.
  t.mock.method(Containers.prototype, 'create', async function(image, mounts, environment) {
    const id = String(next++).padStart(64, '0'); creates.push({ id, image, mounts, environment }); this.ids.add(id); return id;
  });
  t.mock.method(Containers.prototype, 'remove', async function(id) { this.ids.delete(id); calls.push(['remove', id]); });
  t.mock.method(Containers.prototype, 'docker', async function(args) {
    calls.push(args);
    if (args[0] === 'cp' && args.at(-1) === '-') return result(0, archive());
    if (args.includes('/bin/cat')) return result(0, '{"ready":true}');
    if (args.includes('install.mjs')) return result(fault === 'install' ? 13 : 0);
    if (args.includes('build.mjs')) return result(['build', 'ignored-build-failure'].includes(fault) ? 14 : 0);
    if (args.includes('publisher')) { const code = await brokerRequest(work); return result(fault === 'ignored-build-failure' ? 0 : code); }
    return result();
  });
  if (fault === 'artifact') f.adapter.validateArtifact = async () => { throw new Error('bad-artifact'); };
  const executor = await reviewedExecutor({ ...f, root: work, images, inputs: { PROVIDER_TOKEN: 'test-provider-secret', EVIDENCE_WRITE_TOKEN: 'test-writer-secret' }, observe: (phase, value) => observations.push([phase, value]) });
  try {
    assert.equal(creates[0].environment.PROVIDER_TOKEN, 'test-provider-secret'); assert(!creates[0].environment.EVIDENCE_WRITE_TOKEN);
    assert(!existsSync(join(creates[0].mounts.find(m => m.target === '/source').source, 'product/build.mjs')), 'unreviewed source cannot execute with provider authority');
    assert.equal((await executor.execute(executor.commands[0])).exitCode, 0);
    if (fault) await assert.rejects(executor.execute(executor.commands[1]), /isolated-build-failed/);
    else assert.equal((await executor.execute(executor.commands[1])).exitCode, 0);
    const builder = creates[1]; assert.equal(builder.image, images.build);
    assert(!JSON.stringify(builder.environment).includes('secret'));
    assert.deepEqual(builder.mounts.map(m => m.target), ['/source']);
    assert(calls.some(args => args.includes('publisher') && args.includes('/seed/product')), 'literal shell argv and working directory retained');
    assert.equal(executor.artifacts.length, fault ? 0 : 1);
    if (fault === 'install') assert(!calls.some(args => args.includes('build.mjs')));
    if (fault) assert(!calls.some(args => args[0] === 'cp' && String(args.at(-1)).endsWith(':/seed/product/dist')));
    else {
      const pause = calls.findIndex(args => args[0] === 'pause');
      const read = calls.findIndex(args => args[0] === 'cp' && args.at(-1) === '-'); assert(pause >= 0 && pause < read);
    }
    assert(!JSON.stringify(observations).includes('secret'));
  } finally { await executor.close(); }
  assert.equal(calls.filter(args => args[0] === 'remove').length, 2);
  assert(!existsSync(join(work, 'broker')));
}]);
test('generic runner refuses missing Linux attestation before source or adapter execution', async () => {
  await assert.rejects(runStandalone({}, {}), /live-environment-required/);
  await assert.rejects(runStandalone({}, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'runeditrun/base', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', T016_CONTROLLER_IMAGE: images.controller, T016_BUILD_IMAGE: images.build, T016_BROWSER_IMAGE: images.browser }), /isolation-unqualified/);
});

test("reviewed executor routes literal commands through isolated build and artifact custody", async t => {
  await runRows(t, executorRows)
})

test("reviewed source authority excludes dirty files, contract drift and credential bypass", async t => {
  await runRows(t, authorityRows)
})
