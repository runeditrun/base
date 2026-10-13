import assert from 'node:assert/strict';
import { command } from './docker.mjs';
export async function cleanup(ctx) {
  const labels = [ctx.env.T016_CONTAINER_LABEL, 't016-isolation-' + ctx.github.runId, 't016-test-generic'];
  const removed = [], volumesRemoved = [];
  for (const label of labels) {
    assert.match(label, /^t016-[a-z0-9-]{1,80}$/);
    const result = await command(ctx, ['docker', 'ps', '-aq', '--filter', 'label=t016.run=' + label]);
    const ids = result.stdout.toString().trim().split('\n').filter(Boolean);
    for (const id of ids) { assert.match(id, /^[a-f0-9]{12,64}$/); await command(ctx, ['docker', 'rm', '--force', id]); removed.push(id); }
    const remaining = await command(ctx, ['docker', 'ps', '-aq', '--filter', 'label=t016.run=' + label]); assert.equal(remaining.stdout.toString().trim(), '');
    const volumes = await command(ctx, ['docker', 'volume', 'ls', '-q', '--filter', 'label=t016.run=' + label]);
    for (const name of volumes.stdout.toString().trim().split('\n').filter(Boolean)) {
      assert.match(name, /^t016-[a-z0-9-]+-seed-[a-f0-9-]{36}$/); await command(ctx, ['docker', 'volume', 'rm', name]); volumesRemoved.push(name);
    }
    const remainingVolumes = await command(ctx, ['docker', 'volume', 'ls', '-q', '--filter', 'label=t016.run=' + label]); assert.equal(remainingVolumes.stdout.toString().trim(), '');
  }
  const networks = await command(ctx, ['docker', 'network', 'ls', '-q', '--filter', 'label=t016.run=' + ctx.env.T016_CONTAINER_LABEL]);
  for (const id of networks.stdout.toString().trim().split('\n').filter(Boolean)) { assert.match(id, /^[a-f0-9]{12,64}$/); await command(ctx, ['docker', 'network', 'rm', id]); }
  ctx.receipt.file('cleanup/result.json', { labels, removed, volumesRemoved, remaining: [], networksRemoved: networks.stdout.toString().trim().split('\n').filter(Boolean) }, ['cleanup']);
}
