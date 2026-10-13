import assert from 'node:assert/strict';
import { disconnect, inspect } from './docker.mjs';
export async function registryNetwork(ctx, containers, builder, suffix) {
  const name = ctx.env.T016_CONTAINER_LABEL + '-' + suffix;
  await containers.require(['network', 'create', '--internal', '--label', 't016.run=' + ctx.env.T016_CONTAINER_LABEL, name]);
  let proxy;
  try {
    proxy = await containers.create(ctx.images.build, [{ source: ctx.tools, target: '/tests' }], { HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' });
    await containers.require(['network', 'connect', '--alias', 'registry-gateway', name, proxy]);
    await disconnect(containers, builder); await containers.require(['network', 'connect', name, builder]);
    await containers.require(['exec', '--detach', proxy, 'node', '/tests/registry-proxy-entry.mjs']);
    // One bounded readiness wait in-container, not a rerun of installation.
    await containers.require(['exec', proxy, 'node', '-e', `const n=require('net');let done=false;const end=Date.now()+5000;const probe=()=>{const s=n.connect(8123,'127.0.0.1',()=>{done=true;s.end()});s.on('error',()=>{if(Date.now()>end)process.exit(1);setTimeout(probe,25)})};probe()`]);
    const network = JSON.parse((await containers.require(['network', 'inspect', name])).output)[0]; assert.equal(network.Internal, true);
    ctx.receipt.file('networks/' + suffix + '-acquisition.json', network, ['docker-inspect']);
    const info = await inspect(containers, builder, ctx.receipt, 'networks/' + suffix + '-builder.json');
    assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [name]);
    return {
      proxy: 'http://registry-gateway:8123',
      async close() {
        await disconnect(containers, builder);
        const log = await containers.require(['exec', proxy, 'cat', '/tmp/registry-access.jsonl']); ctx.receipt.command({ ...log, argv: ['docker', 'exec', proxy, 'cat', '/tmp/registry-access.jsonl'] }, ['dependency-closures']);
        await containers.remove(proxy); await containers.require(['network', 'rm', name]);
        const final = await inspect(containers, builder, ctx.receipt, 'networks/' + suffix + '-offline.json');
        assert.deepEqual(final.NetworkSettings.Networks, {});
      },
    };
  } catch (error) {
    if (proxy) await containers.remove(proxy); await disconnect(containers, builder); await containers.require(['network', 'rm', name]); throw error;
  }
}
