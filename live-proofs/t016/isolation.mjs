import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from './process.mjs';
import { unpackArtifact, buildIdentity } from './artifact.mjs';
import { insist } from '../../scripts/qualification/operations.mjs';

const imagePattern = /^(?:sha256:[a-f0-9]{64}|ghcr\.io\/runeditrun\/t016-(controller|build|browser)@sha256:[a-f0-9]{64})$/;
export function runtimeImages(env) {
  const values = Object.fromEntries(['controller', 'build', 'browser'].map(role => [role, env['T016_' + role.toUpperCase() + '_IMAGE']]));
  for (const [role, value] of Object.entries(values)) insist(imagePattern.test(value ?? '') &&
    (value.startsWith('sha256:') || value.includes('/t016-' + role + '@')), 'reviewed-runtime-unconfigured');
  return values;
}
export function dockerEnvironment(env) {
  return { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.RUNNER_TEMP, DOCKER_CONFIG: '/nonexistent',
    CI: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}
export const isolationFlags = ['--user', '10001:10001', '--read-only', '--cap-drop=ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '6g', '--cpus', '2',
  '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777'];
export const seedVolumeOptions = Object.freeze({ type: 'tmpfs', device: 'tmpfs', o: 'uid=10001,gid=10001,mode=1777,nosuid,nodev,size=6g' });
export class Containers {
  constructor(env) {
    this.env = dockerEnvironment(env); this.ids = new Set(); this.volumes = new Set(); this.seedVolumes = new Map();
    this.label = env.T016_CONTAINER_LABEL;
    insist(/^t016-[a-z0-9-]{1,80}$/.test(this.label ?? ''), 'container-label-required');
    this.config = mkdtempSync(join(env.RUNNER_TEMP, 't016-docker-config-'));
    this.env.DOCKER_CONFIG = this.config;
    this.signal = () => { this.close().finally(() => process.exit(143)); };
    process.once('SIGTERM', this.signal); process.once('SIGINT', this.signal);
  }
  async docker(args, options = {}) {
    return runProcess(['docker', ...args], { env: this.env, ...options });
  }
  async require(args, options) {
    const result = await this.docker(args, options); insist(result.exitCode === 0, 'container-operation-failed'); return result;
  }
  async create(image, mounts = [], environment = {}) {
    insist(imagePattern.test(image), 'unpinned-runtime');
    // Docker archive operations create a separate view of --tmpfs mounts. A
    // private local-driver tmpfs volume preserves the real /seed bytes during
    // paused reads and admits writes without making the root filesystem writable.
    const volume = this.label + '-seed-' + randomUUID();
    await this.require(['volume', 'create', '--label', 't016.run=' + this.label, '--driver', 'local',
      ...Object.entries(seedVolumeOptions).flatMap(([key, value]) => ['--opt', key + '=' + value]), volume]);
    this.volumes.add(volume);
    const args = ['run', '--detach', '--label', 't016.run=' + this.label, ...isolationFlags, '--workdir', '/seed',
      '--mount', `type=volume,src=${volume},dst=/seed,volume-nocopy`,
      ...mounts.flatMap(({ source, target }) => ['--mount', `type=bind,src=${source},dst=${target},readonly`]),
      ...Object.keys(environment).flatMap(name => ['--env', name]), image, '/bin/sleep', 'infinity'];
    const result = await this.require(args, { env: { ...this.env, ...environment } });
    const id = result.output.toString().trim(); insist(/^[a-f0-9]{64}$/.test(id), 'invalid-container-id'); this.ids.add(id); this.seedVolumes.set(id, volume); return id;
  }
  async remove(id) {
    await this.require(['rm', '--force', id]); this.ids.delete(id);
    const volume = this.seedVolumes.get(id);
    if (volume) { await this.require(['volume', 'rm', volume]); this.volumes.delete(volume); this.seedVolumes.delete(id); }
  }
  async close() {
    const results = await Promise.allSettled([...this.ids].map(id => this.remove(id)));
    const volumes = await Promise.allSettled([...this.volumes].map(async name => {
      await this.require(['volume', 'rm', name]); this.volumes.delete(name);
    }));
    process.removeListener('SIGTERM', this.signal); process.removeListener('SIGINT', this.signal);
    rmSync(this.config, { recursive: true, force: true });
    insist([...results, ...volumes].every(x => x.status === 'fulfilled'), 'container-cleanup-failed');
  }
}
export async function isolatedDeployment({ source, sourceSha, env, root, images, record, observe }) {
  const containers = new Containers(env), brokerRoot = join(root, 'broker');
  mkdirSync(brokerRoot, { mode: 0o755 });
  const control = resolve(new URL('.', import.meta.url).pathname);
  let controller, builder, active = false, build = null, buildError = null;
  const runInside = (id, args, input) => containers.docker(['exec', '--interactive', id, ...args], { input });
  const broker = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/build' || active) { response.writeHead(409).end(); return; }
    active = true; let exitCode = -1;
    try {
      // Never deserialize paths or environment supplied by candidate code.
      const preparedResult = await runInside(controller, ['/bin/cat', `/seed/.seed/deployment/${env.H2H_RESOURCE_PREFIX}/wrangler.json`]);
      insist(preparedResult.exitCode === 0, 'prepared-configuration-missing');
      const prepared = JSON.parse(preparedResult.output.toString());
      const configPath = join(root, 'prepared.json');
      writeFileSync(configPath, JSON.stringify(prepared), { mode: 0o644 });
      await containers.require(['exec', builder, '/bin/mkdir', '-p', `/seed/.seed/deployment/${env.H2H_RESOURCE_PREFIX}`]);
      await containers.require(['cp', configPath, builder + `:/seed/.seed/deployment/${env.H2H_RESOURCE_PREFIX}/wrangler.json`]);
      const result = await runInside(builder, ['/opt/trusted/bin/pnpm', 'build']);
      record(['pnpm', 'build'], result, sourceSha, 'isolated-build');
      exitCode = result.exitCode; if (exitCode !== 0) return;
      // Stop every process the install/build might have left behind before reading
      // its output. Docker pause freezes the full PID namespace for the handoff.
      await containers.require(['pause', builder]);
      const extracted = mkdtempSync(join(root, 'artifact-'));
      const tar = await containers.require(['cp', builder + ':/seed/dist/.', '-']);
      // docker cp emits an archive relative to dist; add a validated prefix.
      const files = unpackArtifact(tar.output, extracted, 'dist');
      build = buildIdentity({ sourceSha, files, root: extracted, prepared });
      await containers.require(['cp', join(extracted, 'dist'), controller + ':/seed/']);
      // Compare the sanitized immutable handoff before the public command resumes.
      observe('build', { sourceSha, artifactSha256: build.artifactSha256, configSha256: build.configSha256,
        workerSha256: build.files.find(x => x.path === 'dist/server/index.js').sha256,
        runtimeImage: images.build, fileCount: build.files.length });
    } catch { buildError = 'isolated-build-failed'; exitCode = -1; }
    finally {
      if (builder) { try { await containers.remove(builder); } catch { buildError = 'container-cleanup-failed'; exitCode = -1; } builder = null; }
      active = false; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ exitCode }));
    }
  });
  await new Promise((resolve, reject) => { broker.once('error', reject); broker.listen(join(brokerRoot, 'build.sock'), resolve); });
  chmodSync(join(brokerRoot, 'build.sock'), 0o666);
  try {
    builder = await containers.create(images.build, [{ source, target: '/source' }],
      { HOME: '/tmp', PATH: '/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin', CI: 'true',
        H2H_WRANGLER_CONFIG: `/seed/.seed/deployment/${env.H2H_RESOURCE_PREFIX}/wrangler.json`,
        H2H_RESOURCE_PREFIX: env.H2H_RESOURCE_PREFIX, H2H_PUBLIC_ORIGIN: env.H2H_PUBLIC_ORIGIN,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, REGISTRATION_ENABLED: 'false', EMAIL_PROVIDER: 'sendgrid' });
    await containers.require(['exec', builder, '/bin/cp', '-R', '/source/.', '/seed/']);
    const installed = await runInside(builder, ['/opt/trusted/bin/pnpm', 'install', '--frozen-lockfile']);
    record(['pnpm', 'install', '--frozen-lockfile'], installed, sourceSha, 'isolated-build');
    insist(installed.exitCode === 0, 'dependencies-failed');
    observe('dependencies', { sourceSha, runtimeImage: images.build, exitCode: 0 });
    const publicEnv = Object.fromEntries(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'H2H_RESOURCE_PREFIX', 'H2H_PUBLIC_ORIGIN',
      'H2H_SETUP_TOKEN', 'REGISTRATION_ENABLED', 'EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
    controller = await containers.create(images.controller,
      [{ source, target: '/source' }, { source: brokerRoot, target: '/broker' }, { source: control, target: '/controller' }],
      { ...publicEnv, HOME: '/tmp', PATH: '/mediator:/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin', CI: 'true', WRANGLER_SEND_METRICS: 'false' });
    await containers.require(['exec', controller, '/bin/cp', '-R', '/source/.', '/seed/']);
    return {
      async execute(argv) {
        insist(JSON.stringify(argv) === JSON.stringify(['pnpm', 'run', 'setup', '--', '--remote']) ||
          JSON.stringify(argv) === JSON.stringify(['pnpm', 'run', 'deploy', '--', '--remote']), 'unreviewed-public-command');
        const result = await runInside(controller, ['/opt/trusted/bin/pnpm', ...argv.slice(1)]);
        record(argv, result, sourceSha, 'trusted-controller');
        insist(!buildError, buildError); return result;
      },
      async readConfig() {
        const result = await runInside(controller, ['/bin/cat', `/seed/.seed/deployment/${env.H2H_RESOURCE_PREFIX}/wrangler.json`]);
        insist(result.exitCode === 0, 'prepared-configuration-missing'); return JSON.parse(result.output.toString());
      },
      artifact() { insist(build, 'missing-build-artifact'); return build; },
      async close() { await containers.close(); await new Promise(resolve => broker.close(resolve)); rmSync(brokerRoot, { recursive: true, force: true }); },
    };
  } catch (error) { await containers.close(); await new Promise(resolve => broker.close(resolve)); throw error; }
}
