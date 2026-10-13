import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { BASE_IMAGE } from './constants.mjs';
import { hash, manifest } from './receipt.mjs';
import { command, dockerContext, disconnect } from './docker.mjs';
import { Incomplete } from './commands.mjs';
import { gzipSync } from 'node:zlib';
export async function buildRuntimes(ctx) {
  const prepared = join(ctx.root, 'runtime-preparation'); mkdirSync(prepared);
  await command(ctx, ['docker', 'pull', '--platform', 'linux/amd64', BASE_IMAGE]).catch(e => { throw new Incomplete(e.message); });
  const manifestResult = await command(ctx, ['docker', 'buildx', 'imagetools', 'inspect', '--raw', BASE_IMAGE]);
  const expectedDigest = BASE_IMAGE.split('@sha256:')[1];
  const cliBytes = manifestResult.stdout, manifestBytes = hash(cliBytes) === expectedDigest ? cliBytes : cliBytes.subarray(0, cliBytes.length - (cliBytes.at(-1) === 10 ? 1 : 0));
  assert.equal(hash(manifestBytes), expectedDigest, 'pulled-manifest-digest');
  ctx.receipt.file('runtime/manifest-framing.json', { cliSha256: hash(cliBytes), manifestSha256: hash(manifestBytes), removedCliNewline: cliBytes.length !== manifestBytes.length }, ['docker-inspect']);
  ctx.receipt.file('runtime/base-manifest.json', manifestResult.stdout, ['docker-inspect']);
  const baseResult = await command(ctx, ['docker', 'image', 'inspect', BASE_IMAGE]);
  const base = JSON.parse(baseResult.stdout)[0]; assert.equal(base.Os, 'linux'); assert.equal(base.Architecture, 'amd64');
  let pulledManifest = JSON.parse(manifestBytes);
  if (Array.isArray(pulledManifest.manifests)) {
    const platform = pulledManifest.manifests.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
    assert.equal(platform.length, 1, 'ambiguous-base-platform');
    const selected = await command(ctx, ['docker', 'buildx', 'imagetools', 'inspect', '--raw', 'node@' + platform[0].digest]);
    const raw = selected.stdout, bytes = hash(raw) === platform[0].digest.slice(7) ? raw : raw.subarray(0, raw.length - (raw.at(-1) === 10 ? 1 : 0));
    assert.equal(hash(bytes), platform[0].digest.slice(7));
    ctx.receipt.file('runtime/base-amd64-manifest.json', bytes, ['docker-inspect']); pulledManifest = JSON.parse(bytes);
  }
  assert.equal(pulledManifest.config.digest, base.Id, 'manifest-config-image-mismatch');
  ctx.receipt.file('runtime/base-image.json', { Id: base.Id, RepoDigests: base.RepoDigests, Os: base.Os, Architecture: base.Architecture, RootFS: base.RootFS }, ['docker-inspect']);
  const context = join(ctx.checkout, 'live-proofs/t016/runtime');
  ctx.receipt.file('runtime/build-context.json', manifest(context), ['dependency-closures']);
  // The committed builder captures subprocess output internally. This transparent
  // executable delegates every argv to the real Docker CLI and preserves status,
  // while retaining its otherwise discarded build logs. It never supplies output.
  const which = await command(ctx, ['which', 'docker']); const actualDocker = which.stdout.toString().trim();
  const bin = join(ctx.root, 'bin'), logs = join(ctx.root, 'docker-build-logs'); mkdirSync(bin); mkdirSync(logs);
  const wrapper = `#!${process.execPath}\nimport {spawnSync} from 'node:child_process'; import fs from 'node:fs'; import crypto from 'node:crypto';\nconst a=process.argv.slice(2), start=new Date().toISOString(); const r=spawnSync(${JSON.stringify(actualDocker)},a,{env:process.env,maxBuffer:40*1024*1024,timeout:1800000});\nconst n=${JSON.stringify(logs)}+'/'+crypto.randomUUID(); fs.writeFileSync(n+'.json',JSON.stringify({argv:['docker',...a],cwd:process.cwd(),startedUtc:start,finishedUtc:new Date().toISOString(),exitCode:r.status??-1,timedOut:r.error?.code==='ETIMEDOUT'})); fs.writeFileSync(n+'.stdout.log',r.stdout??''); fs.writeFileSync(n+'.stderr.log',r.stderr??'');process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);\n`;
  writeFileSync(join(bin, 'docker'), wrapper, { mode: 0o755 });
  try {
    await command(ctx, [process.execPath, 'live-proofs/t016/build-runtimes.mjs', prepared], { env: { ...ctx.env, PATH: bin + ':' + ctx.env.PATH, T016_NODE_BASE_IMAGE: BASE_IMAGE }, timeout: 2700000 });
  } finally {
    for (const name of readdirSync(logs)) ctx.receipt.file('runtime/build-logs/' + name, readFileSync(join(logs, name)), ['dependency-closures']);
  }
  const { images } = JSON.parse(readFileSync(join(prepared, 'runtime-images.json')));
  for (const [role, id] of Object.entries(images)) {
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    const result = await command(ctx, ['docker', 'image', 'inspect', id]); const info = JSON.parse(result.stdout)[0];
    assert.equal(info.Id, id); assert.equal(info.Os, 'linux'); assert.equal(info.Architecture, 'amd64'); assert.equal(info.Config.User, '10001:10001');
    ctx.receipt.file('runtime/' + role + '-image.json', { Id: info.Id, Parent: info.Parent, RootFS: info.RootFS, Os: info.Os, Architecture: info.Architecture, User: info.Config.User, RepoDigests: info.RepoDigests }, ['docker-inspect']);
    ctx.receipt.file('runtime/' + role + '-npm-ls.json', readFileSync(join(prepared, role + '-dependencies.json')), ['dependency-closures']);
  }
  ctx.images = images; ctx.receipt.value.images = images;
  for (const [role, id] of Object.entries(images)) ctx.env['T016_' + role.toUpperCase() + '_IMAGE'] = id;
}
export async function inventory(ctx) {
  const c = dockerContext(ctx.env, ctx.receipt);
  try {
    for (const [role, image] of Object.entries(ctx.images)) {
      const id = await c.create(image, [{ source: ctx.tools, target: '/tests' }], { HOME: '/tmp', PATH: '/opt/trusted/bin:/usr/local/bin:/usr/bin:/bin', WRANGLER_SEND_METRICS: 'false' });
      await disconnect(c, id);
      assert.equal((await c.require(['exec', id, 'node', '--version'])).output.toString().trim(), 'v26.8.1');
      const result = await c.require(['exec', id, 'node', '/tests/runtime-inventory-entry.mjs', role]);
      const data = JSON.parse(result.output); assert.equal(data.node, 'v26.8.1'); assert.equal(data.platform, 'linux'); assert.equal(data.arch, 'x64');
      assert.equal(data.uid, 10001); assert.equal(data.gid, 10001); assert(data.locks.length > 0);
      ctx.receipt.file('runtime/' + role + '-installed.json.gz', gzipSync(JSON.stringify(data, null, 2) + '\n', { level: 9 }), ['dependency-closures', 'os-packages', ...(role === 'browser' ? ['browser-binaries', 'browser-runtime'] : [])]);
      if (role !== 'browser') assert.equal((await c.require(['exec', id, '/opt/trusted/bin/pnpm', '--version'])).output.toString().trim(), '10.12.4');
      if (role === 'controller') assert.match((await c.require(['exec', id, '/opt/trusted/bin/wrangler', '--version'])).output.toString(), /4\.129\.1/);
    }
    ctx.receipt.value.dependencyClosure = 'observed installed closure; transitive npm and apt inputs are not reproducibly locked or independently reviewed';
  } finally { await c.close(); }
}
