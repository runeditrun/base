import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// A real public seed with legacy singleton tool records, never a synthetic app.
const seedRepository = 'https://github.com/just-every/run-pegboard.git';
const seedRevision = 'c5a6a20c693e148ae48ea9be76dad2741104de99';

export function refreshSmoke({ root, installed, base, ref, run, output }) {
 const seed = join(root, 'pegboard');
 run('git', ['init', '--quiet', seed]);
 run('git', ['-C', seed, 'fetch', '--quiet', '--depth=1', seedRepository, seedRevision]);
 run('git', ['-C', seed, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
 const cli = join(installed, 'edition-authoring/cli.mjs');
 const before = JSON.parse(readFileSync(join(seed, 'base-copies.json')));
 const refreshed = JSON.parse(run(process.execPath, [cli, 'refresh-base', ref, '--base', base], { cwd: seed }));
 const record = JSON.parse(readFileSync(join(seed, 'base-copies.json')));
 const recordBytes = readFileSync(join(seed, 'base-copies.json'));
 writeFileSync(join(output, 'base-copies.json'), recordBytes);
 // Both supported entries must work. The refreshed local CLI must have every
 // sibling it imports, without borrowing a helper from the installed package.
 const local = join(seed, 'scripts/edition-authoring/cli.mjs');
 const verified = JSON.parse(run(process.execPath, [local, 'verify-base', '--base', base], { cwd: seed }));
 const packaged = JSON.parse(run(process.execPath, [cli, 'verify-base', '--base', base], { cwd: seed }));
 for (const result of [verified, packaged]) {
  assert.equal(result.ok, true); assert.deepEqual(result.drift, []); assert.deepEqual(result.unrecordedCopies, []);
 }
 const helper = 'scripts/edition-authoring/runtime-dependencies.mjs';
 const copy = record.copies.find(copy => Object.hasOwn(copy.files, helper));
 assert.ok(copy, 'refreshed helper has a source record');
 assert.equal(copy.originPath, 'edition-authoring/runtime-dependencies.mjs');
 const digest = createHash('sha256').update(readFileSync(join(seed, helper))).digest('hex');
 assert.equal(copy.files[helper], digest); assert.equal(copy.revision, ref);
 // Repeating refresh must neither invent unrecorded copies nor change its record.
 run(process.execPath, [cli, 'refresh-base', ref, '--base', base], { cwd: seed });
 assert.deepEqual(readFileSync(join(seed, 'base-copies.json')), recordBytes);
 return { seedRepository, seedRevision, before: before.copies.length, after: record.copies.length,
  refreshed: refreshed.refreshed, helper: { path: helper, originPath: copy.originPath, sha256: digest },
  localVerify: verified.ok, packageVerify: packaged.ok, drift: verified.drift, unrecordedCopies: verified.unrecordedCopies, repeat: true };
}
