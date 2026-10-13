import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotSource } from '../../standalone/review.mjs';
import { dockerContext, disconnect, inspect, confined } from './docker.mjs';
export async function browserSmoke(ctx) {
  const c = dockerContext(ctx.env, ctx.receipt);
  try {
    for (const [version, artifact] of Object.entries(ctx.artifacts)) {
      const id = await c.create(ctx.images.browser, [{ source: ctx.tools, target: '/tests' }, { source: artifact, target: '/artifact' }], { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' });
      await disconnect(c, id); confined(await inspect(c, id, ctx.receipt, 'browser/' + version + '-inspect.json'), ['/tests', '/artifact']);
      const result = await c.require(['exec', id, 'node', '/tests/browser-smoke-entry.mjs']); const data = JSON.parse(result.output);
      for (const shot of data.screenshots) ctx.receipt.file('browser/' + version + '-' + shot.width + '.jpg', Buffer.from(shot.jpg, 'base64'), ['browser-runtime']);
      delete data.screenshots; assert.equal(data.headless, true); assert(data.version); assert.deepEqual(data.pageerrors, []);
      ctx.receipt.file('browser/' + version + '-runtime.json', data, ['browser-runtime', 'browser-binaries']);
      await c.remove(id);
    }
    assert.equal(Object.keys(ctx.artifacts).length, 2, 'both-public-builds-required');
  } finally { await c.close(); }
}
export async function browserBoundary(ctx) {
  // The production boundary mounts its own checkout. Import the exact committed
  // source from a fresh Git-blob snapshot so it has no .git or host ignored files.
  const snapshot = join(ctx.root, 'browser-controller');
  await snapshotSource({ directory: ctx.checkout, sourceSha: ctx.sourceCommit, destination: snapshot, env: ctx.env });
  const { runBrowser } = await import(pathToFileURL(join(snapshot, 'live-proofs/t016/browser-runner.mjs')));
  // The snapshot imports its own Containers class; instrument that exact module
  // only to record actual subprocess results and disconnect the negative probe.
  const boundaryModule = await import(pathToFileURL(join(snapshot, 'live-proofs/t016/isolation.mjs')));
  const boundaryOriginal = boundaryModule.Containers.prototype.docker;
  boundaryModule.Containers.prototype.docker = async function (argv, options) {
    const result = await boundaryOriginal.call(this, argv, options);
    ctx.receipt.command({ ...result, argv: ['docker', ...argv], cwd: ctx.checkout }, ['failure-observations']);
    if (argv[0] === 'run' && result.exitCode === 0) {
      const id = result.output.toString().trim();
      const r = await boundaryOriginal.call(this, ['inspect', id]); assert.equal(r.exitCode, 0);
      const info = JSON.parse(r.output)[0];
      for (const network of Object.keys(info.NetworkSettings.Networks)) assert.equal((await boundaryOriginal.call(this, ['network', 'disconnect', network, id])).exitCode, 0);
    }
    return result;
  };
  let error;
  try { await runBrowser({ origin: 'http://127.0.0.1:1' }, { env: ctx.env, image: ctx.images.browser }); }
  catch (e) { error = e.message; }
  finally { boundaryModule.Containers.prototype.docker = boundaryOriginal; }
  assert.equal(error, 'container-operation-failed');
  const c = dockerContext(ctx.env, ctx.receipt);
  try {
    const id = await c.create(ctx.images.browser, [{ source: snapshot, target: '/controller' }], { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin', T016_BROWSER_CONTAINER: '1', SYNTHETIC_API_KEY: 'forbidden-test-input' });
    await disconnect(c, id);
    const rejected = await c.docker(['exec', '--interactive', id, 'node', '/controller/live-proofs/t016/browser-entry.mjs'], { input: '{}' });
    assert.equal(rejected.exitCode, 1); assert.match(rejected.stderr.toString(), /Hosted browser journey failed/);
    ctx.receipt.file('browser/boundary-negatives.json', { invalidOriginError: error, forbiddenEnvironmentExitCode: rejected.exitCode, hostedJourney: 'pending' }, ['failure-observations', 'browser-runtime']);
  } finally { await c.close(); }
}
