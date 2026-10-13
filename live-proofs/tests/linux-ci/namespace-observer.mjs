import assert from 'node:assert/strict';
import { Containers, seedVolumeOptions } from '../../t016/isolation.mjs';
import { safeInspect, confined } from './docker.mjs';
import { hash } from './receipt.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { unpackArtifact } from '../../t016/artifact.mjs';
const probe = `const fs=require('fs');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),namespaces:Object.fromEntries(['pid','mnt','user'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)])),pids:fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)),mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8'),status:fs.readFileSync('/proc/self/status','utf8')}))`;
// Observation wraps the actual implementation for the duration of one sequential
// fixture. Every operation delegates unchanged; no result, container or subprocess
// is replaced. The only added policy is disconnecting test-only offline fixtures.
export function observeExecutor(ctx, fixture) {
  const original = Containers.prototype.docker, events = [], live = new Map(), seedById = new Map(); let controller, builder, frozenArchiveHash;
  const raw = (self, args, options) => original.call(self, args, options);
  const inspect = async (self, id, phase) => {
    const r = await raw(self, ['inspect', id]); assert.equal(r.exitCode, 0);
    const info = safeInspect(JSON.parse(r.output)[0]);
    const seed = info.Mounts.filter(m => m.Destination === '/seed'); assert.equal(seed.length, 1);
    assert.equal(seed[0].Type, 'volume'); assert(self.volumes.has(seed[0].Name)); seedById.set(id, seed[0].Name);
    const volume = await raw(self, ['volume', 'inspect', seed[0].Name]); assert.equal(volume.exitCode, 0);
    info.seedVolume = JSON.parse(volume.output)[0]; assert.deepEqual(info.seedVolume.Options, seedVolumeOptions);
    ctx.receipt.file(`generic/${fixture.mode}-${phase}-${id.slice(0, 12)}-inspect.json`, info, ['docker-inspect']); return info;
  };
  const namespaces = async self => {
    const rows = {};
    for (const [role, id] of [['controller', controller], ['builder', builder]]) {
      const r = await raw(self, ['exec', id, 'node', '-e', probe]); assert.equal(r.exitCode, 0); rows[role] = JSON.parse(r.output);
      assert.equal(rows[role].uid, 10001); assert.equal(rows[role].gid, 10001);
      assert.match(rows[role].status, /CapEff:\s+0+\n/); assert.match(rows[role].status, /NoNewPrivs:\s+1\n/);
    }
    assert.notEqual(rows.controller.namespaces.pid, rows.builder.namespaces.pid);
    assert.notEqual(rows.controller.namespaces.mnt, rows.builder.namespaces.mnt);
    assert.notEqual(seedById.get(controller), seedById.get(builder), 'shared-seed-volume');
    rows.userNamespaceClaim = 'observed only; shared Docker default is permitted';
    ctx.receipt.file('generic/' + fixture.mode + '-namespaces.json', rows, ['namespaces']);
    const guard = await raw(self, ['exec', controller, 'cat', '/seed/' + fixture.cwd + '/guard']); assert.equal(guard.exitCode, 0);
    assert.equal(guard.output.toString(), 'controller-guard-' + fixture.mode);
    ctx.receipt.file('generic/' + fixture.mode + '-guard.json', { bytes: guard.output.toString(), sha256: hash(guard.output), markerSha256: fixture.markerHash }, ['namespaces']);
  };
  Containers.prototype.docker = async function (argv, options = {}) {
    if (argv[0] === 'pause' && argv[1] === builder) {
      const processes = await raw(this, ['top', builder, '-eo', 'pid,ppid,args']); assert.equal(processes.exitCode, 0);
      assert.match(processes.output.toString(), /mutate\.mjs/);
      ctx.receipt.file('generic/' + fixture.mode + '-live-mutator.log', processes.output, ['namespaces']);
    }
    const result = await raw(this, argv, options);
    if (!(argv[0] === 'cp' && argv.at(-1) === '-')) ctx.receipt.command({ ...result, argv: ['docker', ...argv], cwd: process.cwd() });
    events.push({ argv, exitCode: result.exitCode, utc: new Date().toISOString() });
    if (argv[0] === 'run' && result.exitCode === 0) {
      const id = result.output.toString().trim(); const info = await inspect(this, id, 'created');
      const role = info.Mounts.some(m => m.Destination === '/broker') ? 'controller' : 'builder'; live.set(id, this);
      if (role === 'controller') { controller = id; confined(info, ['/source', '/broker', '/route', '/harness']); }
      else { builder = id; confined(info, ['/source']); }
      for (const network of Object.keys(info.NetworkSettings.Networks)) assert.equal((await raw(this, ['network', 'disconnect', network, id])).exitCode, 0);
      const offline = await inspect(this, id, 'offline'); assert.deepEqual(offline.NetworkSettings.Networks, {});
      if (role === 'builder') await namespaces(this);
    }
    if (argv[0] === 'pause' && argv[1] === builder && result.exitCode === 0) {
      assert.equal((await inspect(this, builder, 'paused')).State.Paused, true);
      const one = await raw(this, ['cp', builder + ':/seed/' + fixture.cwd + '/dist/.', '-']); assert.equal(one.exitCode, 0);
      const two = await raw(this, ['cp', builder + ':/seed/' + fixture.cwd + '/dist/.', '-']); assert.equal(two.exitCode, 0);
      const paths = [join(fixture.root, 'frozen-first'), join(fixture.root, 'frozen-second')]; paths.forEach(p => mkdirSync(p));
      assert.deepEqual(unpackArtifact(one.output, paths[0], 'dist'), unpackArtifact(two.output, paths[1], 'dist')); frozenArchiveHash = hash(one.output);
      const { gzipSync } = await import('node:zlib'); ctx.receipt.file('generic/' + fixture.mode + '-frozen.tar.gz', gzipSync(one.output), ['archives', 'build-artifacts']);
    }
    if (argv[0] === 'rm' && result.exitCode === 0) live.delete(argv.at(-1));
    return result;
  };
  return { events, get controller() { return controller; }, get builder() { return builder; },
    async raw(args) { const self = live.get(controller); assert(self); return raw(self, args); },
    finish() { Containers.prototype.docker = original; ctx.receipt.file('generic/' + fixture.mode + '-events.json', { events, frozenArchiveHash }, ['docker-inspect']); assert.equal(live.size, 0, 'executor-container-leak'); },
  };
}
