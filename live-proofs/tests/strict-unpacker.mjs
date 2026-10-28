import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Receipt, hash } from './linux-ci/receipt.mjs';
import { artifactAdversary } from './linux-ci/artifact-adversary.mjs';
import { tarEntry } from './linux-ci/archive-fixtures.mjs';
import { unpackArtifact } from '../t016/artifact.mjs';
const scratch = () => mkdtempSync(join(tmpdir(), 't016-controls-'));

export const strictUnpackerRows = [['real strict unpacker accepts regular bytes and rejects link/traversal/config targets', {}, () => {
  const root = scratch();
  try {
    const receipt = new Receipt(join(root, 'reports'), {});
    artifactAdversary({ root, receipt });
    const ok = join(root, 'good'); mkdirSync(ok); const files = unpackArtifact(tarEntry('payload'), ok, 'dist');
    assert.equal(files[0].sha256, hash('test')); assert.equal(readFileSync(join(ok, 'dist/payload'), 'utf8'), 'test');
  } finally { rmSync(root, { recursive: true, force: true }); }
}]];
