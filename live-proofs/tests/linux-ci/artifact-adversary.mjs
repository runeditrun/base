import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { unpackArtifact, validateBuildConfig } from '../../t016/artifact.mjs';
import { tarEntry } from './archive-fixtures.mjs';
import { hash } from './receipt.mjs';
export function artifactAdversary(ctx) {
  const rows = [];
  for (const [id, bytes] of [['symlink', tarEntry('payload', { type: '2', link: '/etc/passwd', body: Buffer.alloc(0) })],
    ['hardlink', tarEntry('payload', { type: '1', link: 'other', body: Buffer.alloc(0) })], ['traversal', tarEntry('../escape')]]) {
    const path = join(ctx.root, 'archive-' + id); mkdirSync(path);
    let error; try { unpackArtifact(bytes, path, 'dist'); } catch (e) { error = e.message; }
    assert.equal(error, 'unsafe-artifact-entry'); rows.push({ id, expectedFailure: error, sha256: hash(bytes) });
    ctx.receipt.file('adversaries/' + id + '.tar', bytes, ['archives', 'failure-observations']);
  }
  const prepared = { name: 'test-invalid', main: 'src/server.ts' };
  const valid = { ...prepared, main: 'index.js', no_bundle: true, assets: { directory: '../client' } };
  validateBuildConfig(prepared, valid);
  for (const emitted of [{ ...valid, name: 'wrong-target' }, { ...valid, no_bundle: false }, { ...valid, main: '../../foreign.js' }, { ...valid, assets: { directory: '/etc' } }]) {
    assert.throws(() => validateBuildConfig(prepared, emitted)); rows.push({ emitted, rejected: true });
  }
  ctx.receipt.file('adversaries/results.json', rows, ['failure-observations']);
}
