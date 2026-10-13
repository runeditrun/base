import assert from 'node:assert/strict';
import { reviewedExecutor } from '../../standalone/executor.mjs';
import { genericFixture } from './generic-fixture.mjs';
import { observeExecutor } from './namespace-observer.mjs';
export async function generic(ctx, mode) {
  const fixture = await genericFixture(ctx, mode), observation = observeExecutor(ctx, fixture); let deployment;
  const commands = [], artifacts = [];
  try {
    deployment = await reviewedExecutor({ ...fixture, observe: (kind, value) => (kind === 'command' ? commands : artifacts).push(value) });
    assert.equal(deployment.sourceSha, fixture.adapter.sourceSha); assert.deepEqual(deployment.descriptor, fixture.descriptor);
    assert.deepEqual(deployment.commands.map(({ argv, cwd }) => ({ argv, cwd })), Object.values(fixture.descriptor.commands).map(({ argv, cwd }) => ({ argv, cwd })));
    assert.equal((await deployment.execute(deployment.commands[0])).exitCode, 0);
    let result, error;
    try { result = await deployment.execute(deployment.commands[1]); } catch (e) { error = e.message; }
    const publication = await observation.raw(['exec', observation.controller, 'test', '-e', '/seed/' + fixture.cwd + '/publication-sentinel']);
    ctx.receipt.command({ ...publication, argv: ['docker', 'exec', observation.controller, 'test', '-e', '/seed/' + fixture.cwd + '/publication-sentinel'] }, ['failure-observations']);
    if (mode === 'success') {
      assert.equal(error, undefined); assert.equal(result.exitCode, 0); assert.equal(publication.exitCode, 0); assert.equal(artifacts.length, 1);
      const line = result.output.toString().trim().split('\n').at(-1), emitted = JSON.parse(line);
      assert.equal(emitted.payloadSha256, artifacts[0].files[0].sha256); assert.equal(emitted.cwd, '/seed/' + fixture.cwd);
      const removedAt = observation.events.findIndex(e => e.argv[0] === 'rm' && e.argv.at(-1) === observation.builder && e.exitCode === 0);
      const resumedAt = observation.events.findIndex(e => e.argv[0] === 'exec' && e.argv.includes(observation.controller) && e.argv.includes('declared-shell'));
      assert(removedAt >= 0 && resumedAt > removedAt, 'builder-not-removed-before-controller-resumed');
      const gone = await observation.raw(['inspect', observation.builder]); assert.notEqual(gone.exitCode, 0);
    } else {
      assert.equal(error, 'isolated-build-failed'); assert.equal(publication.exitCode, 1); assert.equal(artifacts.length, 0);
      const buildCommands = commands.filter(x => x.boundary === 'isolated-build');
      assert.equal(buildCommands.length, mode === 'install-failure' ? 1 : 2);
      assert.notEqual(buildCommands.at(-1).exitCode, 0);
    }
    ctx.receipt.file('generic/' + mode + '-result.json', { sourceSha: fixture.adapter.sourceSha, descriptorSha256: fixture.adapter.descriptorSha256,
      controllerFiles: fixture.adapter.controllerFiles, commands, artifacts, error, markerSha256: fixture.markerHash, publicationExitCode: publication.exitCode },
    ['failure-observations', ...(mode === 'success' ? ['build-artifacts'] : [])]);
  } finally { try { if (deployment) await deployment.close(); } finally { observation.finish(); } }
}
