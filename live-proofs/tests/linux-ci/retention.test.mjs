import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Receipt, hash } from './receipt.mjs';

test('large subprocess observations retain every sanitized byte within the unchanged report bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'receipt-retention-'));
  try {
    const receipt = new Receipt(root, {}); receipt.secrets.push('synthetic-private-marker');
    const stdout = JSON.stringify({ dependencies: Array.from({ length: 10000 }, (_, i) => ({ name: 'package-' + i, version: '1.0.0' })) });
    const stderr = 'synthetic-private-marker\n'.repeat(1000);
    const row = receipt.command({ argv: ['test-only'], exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
    for (const [stream, expected] of [['stdout', stdout], ['stderr', receipt.sanitize(stderr)]]) {
      const stored = readFileSync(join(root, row[stream])), bytes = gunzipSync(stored);
      assert.equal(bytes.toString(), expected); assert.equal(row.streams[stream].encoding, 'gzip');
      assert.equal(row.streams[stream].size, bytes.length); assert.equal(row.streams[stream].sha256, hash(bytes));
      assert(stored.length < bytes.length); assert(!bytes.includes(Buffer.from('synthetic-private-marker')));
    }
    const small = receipt.command({ argv: ['test-only'], exitCode: 23, stdout: 'small', stderr: 'failure' });
    assert.equal(small.exitCode, 23); assert.equal(small.streams.stdout.encoding, 'utf8');
    assert.equal(readFileSync(join(root, small.stdout), 'utf8'), 'small');
    assert.throws(() => receipt.file('too-large.bin', Buffer.alloc(50_000_000)), /report-file-limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
