import assert from 'node:assert/strict';
import { Containers, seedVolumeOptions } from '../../t016/isolation.mjs';
import { execute, assertExecution } from './commands.mjs';
export function dockerContext(env, receipt) {
  const containers = new Containers(env);
  const original = containers.docker.bind(containers);
  containers.docker = async (argv, options = {}) => {
    const result = await original(argv, options);
    const binary = argv[0] === 'cp' && argv.at(-1) === '-';
    if (!binary) receipt.command({ ...result, argv: ['docker', ...argv], cwd: process.cwd() });
    return result;
  };
  return containers;
}
export async function command(ctx, argv, options = {}, groups = []) {
  const result = await execute(argv, { cwd: ctx.checkout, env: ctx.env, ...options });
  ctx.receipt.command(result, groups); return assertExecution(result);
}
export function safeInspect(row) {
  return { Id: row.Id, Image: row.Image, Name: row.Name, State: row.State,
    Config: { User: row.Config.User, WorkingDir: row.Config.WorkingDir, EnvNames: row.Config.Env?.map(x => x.split('=')[0]), Labels: row.Config.Labels },
    HostConfig: { ReadonlyRootfs: row.HostConfig.ReadonlyRootfs, CapDrop: row.HostConfig.CapDrop,
      SecurityOpt: row.HostConfig.SecurityOpt, Privileged: row.HostConfig.Privileged, PidMode: row.HostConfig.PidMode,
      NetworkMode: row.HostConfig.NetworkMode, Binds: row.HostConfig.Binds, Tmpfs: row.HostConfig.Tmpfs },
    Mounts: row.Mounts, NetworkSettings: { Networks: row.NetworkSettings.Networks } };
}
export async function inspect(containers, id, receipt, name) {
  // Inspect can contain a synthetic credential; retain only explicit fields.
  const result = await Containers.prototype.docker.call(containers, ['inspect', id]);
  assert.equal(result.exitCode, 0); const row = safeInspect(JSON.parse(result.output)[0]);
  const seed = row.Mounts.filter(m => m.Destination === '/seed');
  assert.equal(seed.length, 1); assert.equal(seed[0].Type, 'volume');
  assert.equal(seed[0].Name, containers.seedVolumes.get(id), 'private-seed-volume-required');
  const volume = await containers.require(['volume', 'inspect', seed[0].Name]);
  row.seedVolume = JSON.parse(volume.output)[0];
  receipt.file(name, row, ['docker-inspect']); return row;
}
export function confined(row, allowedMounts) {
  assert.equal(row.Config.User, '10001:10001'); assert.equal(row.HostConfig.ReadonlyRootfs, true);
  assert.equal(row.HostConfig.Privileged, false); assert(row.HostConfig.CapDrop.includes('ALL'));
  assert(row.HostConfig.SecurityOpt.includes('no-new-privileges')); assert.notEqual(row.HostConfig.PidMode, 'host');
  assert.notEqual(row.HostConfig.NetworkMode, 'host');
  assert.equal(row.seedVolume.Driver, 'local'); assert.deepEqual(row.seedVolume.Options, seedVolumeOptions);
  assert.equal(row.seedVolume.Labels['t016.run'], row.Config.Labels['t016.run']);
  const seed = row.Mounts.filter(x => x.Destination === '/seed'); assert.equal(seed.length, 1);
  assert.equal(seed[0].Type, 'volume'); assert.equal(seed[0].RW, true); assert.equal(seed[0].Name, row.seedVolume.Name);
  const binds = row.Mounts.filter(x => x.Type !== 'tmpfs' && x.Destination !== '/seed');
  assert.deepEqual(binds.map(x => x.Destination).sort(), [...allowedMounts].sort());
  for (const mount of binds) { assert.equal(mount.Type, 'bind'); assert.equal(mount.RW, false); assert(!/docker\.sock/.test(mount.Source)); }
}
export async function disconnect(containers, id) {
  const result = await Containers.prototype.docker.call(containers, ['inspect', id]); assert.equal(result.exitCode, 0);
  for (const network of Object.keys(JSON.parse(result.output)[0].NetworkSettings.Networks)) await containers.require(['network', 'disconnect', network, id]);
}
