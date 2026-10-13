import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execute, assertExecution } from './commands.mjs';
import { hash } from './receipt.mjs';
// Independent native-build test input materialization. This deliberately does
// not qualify or replace the production executor's snapshotSource acceptance.
export async function publicSnapshot(ctx, repository, sha, destination) {
  const git = async (args, input) => {
    const result = assertExecution(await execute(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, env: ctx.env, input, limit: 256 * 1024 * 1024 }));
    ctx.receipt.command({ ...result, stdout: Buffer.from(JSON.stringify({ bytes: result.stdout.length, sha256: hash(result.stdout) })) }, ['public-sources']);
    return result.stdout;
  };
  const entries = (await git(['ls-tree', '-rz', '--full-tree', sha])).toString().split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\x20-\x7e]+)$/.exec(row); assert(match, 'public-nonregular-or-nonportable-path');
    const [, mode, blob, path] = match;
    assert(!path.startsWith('/') && !path.includes('\\') && path.split('/').every(p => p && !['.', '..', '.git'].includes(p)), 'public-noncanonical-path');
    return { mode, blob, path };
  });
  assert(entries.length > 0 && entries.length < 20000); assert.equal(new Set(entries.map(e => e.path)).size, entries.length);
  const batch = await git(['cat-file', '--batch'], entries.map(e => e.blob).join('\n') + '\n');
  mkdirSync(destination, { mode: 0o755 }); let offset = 0; const files = [];
  for (const entry of entries) {
    const end = batch.indexOf(10, offset); assert(end >= offset);
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(batch.subarray(offset, end).toString()); assert(match); assert.equal(match[1], entry.blob);
    const size = Number(match[2]); assert(Number.isSafeInteger(size) && size < 64 * 1024 * 1024); offset = end + 1;
    assert(offset + size < batch.length); const bytes = batch.subarray(offset, offset + size);
    const blob = createHash('sha1').update(Buffer.from('blob ' + size + '\0')).update(bytes).digest('hex'); assert.equal(blob, entry.blob);
    assert.equal(batch[offset + size], 10); offset += size + 1;
    mkdirSync(join(destination, entry.path, '..'), { recursive: true, mode: 0o755 }); writeFileSync(join(destination, entry.path), bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    files.push({ path: entry.path, size, sha256: hash(bytes), gitBlob: entry.blob });
  }
  assert.equal(offset, batch.length); return files;
}
