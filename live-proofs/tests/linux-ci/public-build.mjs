import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { unpackArtifact, buildIdentity } from '../../t016/artifact.mjs';
import { dockerContext, inspect, confined, disconnect } from './docker.mjs';
import { registryNetwork } from './network.mjs';
import { hash } from './receipt.mjs';
import { nativeBuildConfig } from './native-config.mjs';
export function preparedConfig(source) {
  // These public snapshots contain strict JSON in wrangler.jsonc. Refuse syntax
  // drift instead of evaluating source or invoking setup/provider tooling.
  const config = JSON.parse(readFileSync(join(source, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.main, 'src/server.ts'); assert.equal(config.d1_databases.length, 1);
  const name = 't016-native-test'; config.name = name;
  config.d1_databases[0] = { ...config.d1_databases[0], database_name: name, database_id: '11111111-1111-4111-8111-111111111111', migrations_dir: '/seed/.generated/migrations' };
  for (const bucket of config.r2_buckets) bucket.bucket_name = name + '-files';
  for (const row of [...config.queues.producers, ...config.queues.consumers]) {
    row.queue = name + (row.queue.endsWith('-dead') ? '-jobs-dead' : '-jobs');
    if (row.dead_letter_queue) row.dead_letter_queue = name + '-jobs-dead';
  }
  config.account_id = '11111111111111111111111111111111';
  config.vars = { APP_ORIGIN: 'https://t016-native.invalid', REGISTRATION_ENABLED: 'false', EMAIL_PROVIDER: 'sendgrid' };
  return config;
}
export async function publicBuild(ctx, pin) {
  const input = ctx.sources[pin.id], c = dockerContext(ctx.env, ctx.receipt); let gateway;
  const prepared = preparedConfig(input.source), prep = join(input.root, 'prepared.json'); writeFileSync(prep, JSON.stringify(prepared), { mode: 0o644 });
  ctx.receipt.file('builds/' + pin.id + '-prepared.json', prepared, ['build-artifacts']);
  const expected = nativeBuildConfig(prepared);
  ctx.receipt.file('builds/' + pin.id + '-expected.json', expected, ['build-artifacts']);
  try {
    const id = await c.create(ctx.images.build, [{ source: input.source, target: '/source' }], {
      HOME: '/tmp', PATH: '/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin', CI: 'true',
      H2H_WRANGLER_CONFIG: '/seed/qualification-wrangler.json', WRANGLER_SEND_METRICS: 'false',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', CLOUDFLARE_ACCOUNT_ID: '11111111111111111111111111111111',
    });
    confined(await inspect(c, id, ctx.receipt, 'builds/' + pin.id + '-container.json'), ['/source']);
    await c.require(['exec', id, '/bin/cp', '-R', '/source/.', '/seed/']); await c.require(['cp', prep, id + ':/seed/qualification-wrangler.json']);
    gateway = await registryNetwork(ctx, c, id, pin.id);
    const installed = await c.docker(['exec', '--env', 'HTTPS_PROXY=' + gateway.proxy, '--env', 'HTTP_PROXY=' + gateway.proxy,
      '--env', 'npm_config_registry=https://registry.npmjs.org', id, '/opt/trusted/bin/pnpm', 'install', '--frozen-lockfile', '--fetch-retries=0']);
    await gateway.close(); gateway = null;
    assert.equal(installed.exitCode, 0, 'public-native-install-failed');
    const inventory = await c.require(['exec', id, '/opt/trusted/bin/pnpm', 'list', '--depth', 'Infinity', '--json']);
    ctx.receipt.file('builds/' + pin.id + '-dependencies.json.gz', gzipSync(inventory.output, { level: 9 }), ['dependency-closures']);
    const lock = await c.require(['exec', id, 'cat', '/seed/node_modules/.pnpm/lock.yaml']); ctx.receipt.file('builds/' + pin.id + '-installed-lock.yaml.gz', gzipSync(lock.output, { level: 9 }), ['dependency-closures']);
    const built = await c.docker(['exec', id, '/opt/trusted/bin/pnpm', 'build']); assert.equal(built.exitCode, 0, 'public-native-build-failed');
    await c.require(['pause', id]); const frozen = await inspect(c, id, ctx.receipt, 'builds/' + pin.id + '-paused.json'); assert.equal(frozen.State.Paused, true);
    const archive = await c.require(['cp', id + ':/seed/dist/.', '-']);
    ctx.receipt.file('builds/' + pin.id + '-artifact.tar.gz', gzipSync(archive.output, { level: 9 }), ['archives', 'build-artifacts']);
    const extracted = join(input.root, 'artifact'); mkdirSync(extracted); const files = unpackArtifact(archive.output, extracted, 'dist');
    const identity = buildIdentity({ sourceSha: pin.sha, files, root: extracted, prepared: expected });
    const controller = await c.create(ctx.images.controller, [], { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' }); await disconnect(c, controller);
    await c.require(['cp', join(extracted, 'dist'), controller + ':/seed/']);
    const copy = await c.require(['cp', controller + ':/seed/dist/.', '-']); const check = join(input.root, 'controller-artifact'); mkdirSync(check);
    assert.deepEqual(unpackArtifact(copy.output, check, 'dist'), files);
    await c.remove(id);
    const absent = await c.docker(['inspect', id]); assert.notEqual(absent.exitCode, 0);
    ctx.receipt.file('builds/' + pin.id + '-handoff.json', { ...identity, archiveSha256: hash(archive.output), controllerArchiveSha256: hash(copy.output), builderRemoved: true, providerExecuted: false }, ['build-artifacts']);
    ctx.artifacts[pin.id] = extracted;
  } finally { try { if (gateway) await gateway.close(); } finally { await c.close(); } }
}
