import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Containers } from '../t016/isolation.mjs';
import { unpackArtifact } from '../t016/artifact.mjs';
import { digest, insist, readOperations } from '../../scripts/qualification/operations.mjs';
import { containerCwd, copyControllerFiles, credentialNames, reviewDescriptor, snapshotSource, sourcePath } from './review.mjs';

const buildEnvironment = { HOME: '/tmp', PATH: '/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin', CI: 'true',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
export async function reviewedExecutor({ directory, adapter, env, inputs, origin, root, images, remoteSelection, observe = () => {} }) {
  const source = join(root, 'source'), reviewed = join(root, 'reviewed'), brokerRoot = join(root, 'broker'), routes = join(root, 'routes');
  await snapshotSource({ directory, sourceSha: adapter.sourceSha, destination: source, env });
  const descriptor = readOperations(source), { commands, names } = reviewDescriptor(descriptor, adapter, remoteSelection);
  insist(names.every(name => typeof inputs[name] === 'string' && inputs[name].trim()), 'missing-seed-input');
  if (adapter.validateInputs) await adapter.validateInputs(Object.fromEntries(names.map(name => [name, inputs[name]])), { origin });
  copyControllerFiles(source, reviewed, adapter.controllerFiles, adapter.controllerDirectories);
  mkdirSync(brokerRoot, { mode: 0o755 }); mkdirSync(routes, { mode: 0o755 });
  const policy = { builds: adapter.builds.map(build => ({ argv: build.argv, cwd: containerCwd(build.cwd) })),
    commands: commands.map(command => ({ argv: command.argv, cwd: containerCwd(command.cwd) })), tools: structuredClone(adapter.tools) };
  // Public command argv is still literal. If it uses a routed executable, its
  // exact top-level arguments are admitted alongside the reviewed provider tools.
  writeFileSync(join(routes, 'policy.json'), JSON.stringify(policy), { mode: 0o644 });
  for (const name of new Set(adapter.builds.map(build => build.argv[0]))) {
    writeFileSync(join(routes, name), `#!/usr/local/bin/node\nimport { mediate } from '/harness/mediator.mjs';\nawait mediate(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  const containers = new Containers(env);
  const run = (id, argv, cwd = '.', input) => containers.docker(['exec', '--interactive', '--workdir', containerCwd(cwd), id, ...argv], { input });
  let controller, active = false, failure = null, closed = false;
  const artifacts = [];
  const record = (boundary, argv, cwd, result) => observe('command', { boundary, argv, cwd: containerCwd(cwd), sourceSha: adapter.sourceSha,
    exitCode: result.exitCode, outputSha256: result.outputHash, startedUtc: result.startedUtc, finishedUtc: result.finishedUtc });
  const broker = createServer(async (request, response) => {
    const match = /^\/build\/([0-9]+)$/.exec(request.url), build = match && adapter.builds[Number(match[1])];
    if (request.method !== 'POST' || !build || active || failure) { response.writeHead(409).end(); return; }
    active = true; let builder, exitCode = -1;
    try {
      const publicInputs = Object.fromEntries((build.publicEnvironment ?? []).map(name => [name, inputs[name]]));
      const mapped = typeof build.environment === 'function' ? build.environment(publicInputs) : build.environment;
      insist(mapped && Object.entries(mapped).every(([name, value]) => credentialNames([name]) && typeof value === 'string'), 'invalid-build-environment');
      builder = await containers.create(images.build, [{ source, target: '/source' }], { ...mapped, ...buildEnvironment });
      await containers.require(['exec', builder, '/bin/cp', '-R', '/source/.', '/seed/']);
      // Only a reviewed adapter chooses generated nonsecret build inputs. The
      // builder never chooses paths to read in the credential-bearing container.
      const prepared = adapter.prepareBuild ? await adapter.prepareBuild({ index: Number(match[1]), publicInputs, readFile: async path => {
        sourcePath(path); const result = await run(controller, ['/bin/cat', posix.join('/seed', path)]);
        insist(result.exitCode === 0, 'prepared-input-missing'); return result.output;
      } }) : [];
      insist(Array.isArray(prepared), 'invalid-prepared-input');
      for (const [index, file] of prepared.entries()) {
        sourcePath(file.path); insist(Buffer.isBuffer(file.bytes) && file.bytes.length <= 1024 * 1024, 'invalid-prepared-input');
        const path = join(root, 'prepared-' + index); writeFileSync(path, file.bytes, { mode: 0o644 });
        await containers.require(['exec', builder, '/bin/mkdir', '-p', posix.dirname(posix.join('/seed', file.path))]);
        await containers.require(['cp', path, builder + ':' + posix.join('/seed', file.path)]);
        rmSync(path);
      }
      for (const argv of [...(build.install ?? []), build.argv]) {
        const result = await run(builder, argv, build.cwd); record('isolated-build', argv, build.cwd, result);
        exitCode = result.exitCode;
        if (exitCode !== 0) { failure = 'isolated-build-failed'; return; }
      }
      await containers.require(['pause', builder]);
      const archive = await containers.require(['cp', builder + ':' + posix.join('/seed', build.output) + '/.', '-']);
      const extracted = mkdtempSync(join(root, 'artifact-'));
      const files = unpackArtifact(archive.output, extracted, 'dist');
      // Adapter must validate target/configuration and prove that publication
      // consumes inert bytes (e.g. Wrangler no_bundle), never executes the build.
      await adapter.validateArtifact({ root: extracted, files, prepared, index: Number(match[1]) });
      await containers.require(['exec', controller, '/bin/mkdir', '-p', posix.dirname(posix.join('/seed', build.output))]);
      await containers.require(['exec', controller, '/bin/rm', '-rf', posix.join('/seed', build.output)]);
      await containers.require(['cp', join(extracted, 'dist'), controller + ':' + posix.join('/seed', build.output)]);
      artifacts.push({ sourceSha: adapter.sourceSha, output: build.output, sha256: digest(files), files });
      observe('artifact', artifacts.at(-1));
    } catch { failure = 'isolated-build-failed'; exitCode = -1; }
    finally {
      if (builder) { try { await containers.remove(builder); } catch { failure = 'container-cleanup-failed'; exitCode = -1; } }
      active = false; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ exitCode }));
    }
  });
  const close = async () => {
    if (closed) return; closed = true;
    try { await containers.close(); }
    finally {
      if (broker.listening) await new Promise(resolve => broker.close(resolve));
      rmSync(brokerRoot, { recursive: true, force: true });
    }
  };
  try {
    await new Promise((resolve, reject) => { broker.once('error', reject); broker.listen(join(brokerRoot, 'build.sock'), resolve); });
    chmodSync(join(brokerRoot, 'build.sock'), 0o666);
    const deploymentEnvironment = Object.fromEntries(adapter.deploymentEnvironment.map(name => [name, inputs[name]]));
    controller = await containers.create(images.controller, [{ source: reviewed, target: '/source' }, { source: brokerRoot, target: '/broker' },
      { source: routes, target: '/route' }, { source: fileURLToPath(new URL('.', import.meta.url)), target: '/harness' }],
    { ...deploymentEnvironment, ...buildEnvironment, PATH: '/route:' + buildEnvironment.PATH, WRANGLER_SEND_METRICS: 'false' });
    await containers.require(['exec', controller, '/bin/cp', '-R', '/source/.', '/seed/']);
    return { descriptor, sourceSha: adapter.sourceSha, commands, artifacts,
      async execute(command) {
        insist(commands.some(item => JSON.stringify(item) === JSON.stringify(command)), 'unreviewed-public-command');
        const result = await run(controller, command.argv, command.cwd);
        record('reviewed-controller', command.argv, command.cwd, result);
        insist(!failure, failure); return result;
      }, close };
  } catch (error) { await close(); throw error; }
}
