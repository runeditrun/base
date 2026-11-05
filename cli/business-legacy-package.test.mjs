import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { legacyPackage } from './fixtures/business/legacy-package.mjs';
import { cli, connect, legacyTask } from './fixtures/business/legacy-cli.mjs';
import { server } from './fixtures/business/server.mjs';
import { door } from './fixtures/business/door.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function home(t) { const root = await mkdtemp(join(tmpdir(), '.business-connect-legacy-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('P4 registration refuses size, SHA, counts and detector failures without upload; output contains only counts and SHA', async t => {
 const root = await home(t), pkg = await legacyPackage(join(root, 'package')), manifestPath = join(pkg.root, 'manifest.json');
 const registered = await cli(root, ['legacy-package', 'add', pkg.root]);
 assert.equal(registered.code, 0, registered.stderr);
 const result = JSON.parse(registered.stdout);
 assert.deepEqual(Object.keys(result).sort(), ['bytes', 'manifestSha256', 'objects', 'rowCounts']);
 assert.deepEqual(result.rowCounts, pkg.manifest.source.rowCounts);
 assert.equal(result.manifestSha256, sha(pkg.files.get('manifest.json')));
 assert.equal((await stat(join(root, '.rer/business/legacy-package.json'))).mode & 0o777, 0o600);
 const part = pkg.manifest.chunks[0], path = join(pkg.root, part.file), original = await readFile(path);
 const cases = [
  ['size', () => writeFile(path, Buffer.concat([original, Buffer.from(' ')])), /size/],
  ['SHA', () => writeFile(path, Buffer.from(original.toString().replace('Old', 'New'))), /SHA-256/],
  ['count', async () => { const bad = structuredClone(pkg.manifest); bad.source.rowCounts.conversations++; await writeFile(manifestPath, JSON.stringify(bad)); }, /count/],
  ['detector', async () => { const rows = JSON.parse(original); rows[0].subject = 'gh' + 'p_' + 'synthetic-credential'; const bytes = Buffer.from(JSON.stringify(rows)), bad = structuredClone(pkg.manifest); bad.chunks[0] = { ...part, bytes: bytes.length, sha256: sha(bytes) }; await writeFile(path, bytes); await writeFile(manifestPath, JSON.stringify(bad)); }, /outbound detector/],
 ];
 for (const [label, mutate, reason] of cases) {
  await writeFile(path, original); await writeFile(manifestPath, pkg.files.get('manifest.json')); await mutate();
  const refused = await cli(root, ['legacy-package', 'add', pkg.root]);
  assert.equal(refused.code, 1, label); assert.match(refused.stderr, reason); assert.match(refused.stderr, /row \d+.*repass/);
  assert.equal(refused.stdout, '', label); assert.ok(!refused.stderr.includes('synthetic-credential'));
 }
 await writeFile(path, original); await writeFile(manifestPath, pkg.files.get('manifest.json'));
 const remote = await server(t), destination = await door(t); remote.state.door = destination; remote.state.exportVendor = 'happytohelp-legacy';
 assert.equal((await connect(root, remote)).code, 0);
 await cli(root, ['legacy-package', 'add', pkg.root]);
 await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
 remote.state.tasks = [legacyTask('changed-package')];
 const run = await cli(root, ['run', '--once']);
 assert.equal(run.code, 1); assert.match(run.stderr, /Legacy package changed/); assert.ok(run.stderr.includes(pkg.root));
 assert.equal(remote.state.released.reason, 'paused'); assert.equal(destination.state.uploads.size, 0);
 t.diagnostic('PROBE P4 size/SHA/count/detector refused before upload; changed package paused and named locally');
});

test('manifest-first unsupported door sends no segments; a declared fixture door plans one complete package and disconnect cleans registration and journal', async t => {
 const root = await home(t), pkg = await legacyPackage(join(root, 'package')), remote = await server(t), destination = await door(t);
 remote.state.door = destination; remote.state.exportVendor = 'happytohelp-legacy';
 assert.equal((await connect(root, remote)).code, 0); assert.equal((await cli(root, ['legacy-package', 'add', pkg.root])).code, 0);
 destination.state.packageUnsupported = true; remote.state.tasks = [legacyTask('unsupported-legacy')];
 const refused = await cli(root, ['run', '--once']); assert.equal(refused.code, 1); assert.match(refused.stderr, /SEED_PACKAGE_UNSUPPORTED/);
 assert.ok([...destination.state.uploads.values()].every(upload => upload.name === 'rer-package.json')); assert.equal(destination.state.plans.length, 0);
 destination.state.packageUnsupported = false;
 remote.state.tasks = [legacyTask('small-legacy')];
 const result = await cli(root, ['run', '--once']);
 assert.equal(result.code, 0, result.stderr); assert.equal(destination.state.plans.length, 1); assert.equal(destination.state.nativeWrites, 0);
 const manifest = [...destination.state.uploads.values()].find(u => u.name === 'rer-package.json');
 assert.equal(JSON.parse(manifest.bytes).records.total, null);
 assert.deepEqual(JSON.parse(manifest.bytes).totals.rowCounts, pkg.manifest.source.rowCounts);
 assert.equal((await cli(root, ['legacy-package', 'status', pkg.root])).code, 0);
 assert.equal((await cli(root, ['disconnect'])).code, 0);
 await assert.rejects(stat(join(root, '.rer/business/legacy-package.json')), { code: 'ENOENT' });
 await assert.rejects(stat(join(root, '.rer/business')), { code: 'ENOENT' });
});
