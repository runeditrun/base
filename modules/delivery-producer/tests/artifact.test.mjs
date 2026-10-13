import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, truncate, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { crc32 } from 'node:zlib';
import { produceArtifact } from '../artifact.mjs';
import { MAX_ARTIFACT_ENTRY_BYTES, MAX_ARTIFACT_PAYLOAD_BYTES, MAX_ARTIFACT_ENTRIES, mimeType, validatePayloadBounds } from '../payloads.mjs';

const specInputs = { recovery: 'Restore retained source and application data.' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function put(root, path, bytes) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-producer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'dist/server/wrangler.json', JSON.stringify({ compatibility_date: '2026-09-01' }));
  await put(root, 'dist/server/index.js', 'export default { fetch() { return new Response("ok"); } };\r\n');
  await put(root, 'dist/client/index.html', '<!doctype html><title>Artifact</title>\n');
  return root;
}
async function build(root, extra = {}) { return produceArtifact({ root, specInputs, ...extra }); }
async function manifest(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function snapshot(directory) {
  const result = {};
  async function visit(path = '') {
    for (const name of (await readdir(join(directory, path))).sort()) {
      const child = path ? `${path}/${name}` : name;
      if ((await lstat(join(directory, child))).isDirectory()) await visit(child);
      else result[child] = await readFile(join(directory, child));
    }
  }
  await visit(); return result;
}

test('schema-2 packages deterministic exact raw bytes, code-unit order, and an explicit wrapper', async t => {
  const root = await fixture(t);
  const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
  await put(root, 'dist/server/Z.js', 'export const z = 1;');
  await put(root, 'dist/server/a.mjs', 'export const a = 1;');
  await put(root, 'dist/server/blob.wasm', binary);
  await put(root, 'dist/server/index.js.map', '{"sources":["private-source.ts"]}');
  await put(root, 'dist/server/chunks/wrangler.json', '{}');
  await put(root, 'dist/client/picture.png', binary);
  await put(root, 'scripts/entry.mjs', 'export { default } from "./index.js";\n');
  const options = { mainModule: 'rer-entry.js', additionalModules: [{ name: 'rer-entry.js', type: 'esm', path: 'scripts/entry.mjs' }] };
  const first = await build(root, { ...options, output: 'one/package.json' });
  await mkdir(join(root, 'two'));
  const second = await build(root, { ...options, output: 'two/package.json' });
  assert.equal(first, join(root, 'one/package.json'));
  assert.deepEqual(await snapshot(dirname(first)), await snapshot(dirname(second)));
  const data = await manifest(first);
  assert.equal(data.schema, 2);
  assert.equal(data.deploymentSpec.schema, 1);
  assert.equal(data.mainModule, 'rer-entry.js');
  assert.deepEqual(data.modules.map(m => [m.name, m.type]), [['Z.js', 'esm'], ['a.mjs', 'esm'], ['blob.wasm', 'compiled-wasm'], ['index.js', 'esm'], ['rer-entry.js', 'esm']]);
  for (const entry of [...data.modules, ...data.assets]) {
    const original = entry.role === 'module' ? entry.name === 'rer-entry.js' ? 'scripts/entry.mjs' : `dist/server/${entry.name}` : `dist/client${entry.path}`;
    const bytes = await readFile(join(root, original));
    assert.deepEqual(await readFile(join(dirname(first), entry.payload)), bytes);
    assert.equal(entry.size, bytes.length); assert.equal(entry.sha256, digest(bytes));
  }
  assert.equal(data.assets.find(a => a.path === '/picture.png').contentType, 'image/png');
  assert.ok(!(await readdir(dirname(first))).includes('release-provenance.json'));
});

test('MIME policy preserves existing common values and treats unknown bytes as opaque', () => {
  for (const [path, expected] of Object.entries({ 'a.js': 'application/javascript', 'a.css': 'text/css', 'a.html': 'text/html', 'a.json': 'application/json', 'a.svg': 'image/svg+xml', 'a.png': 'image/png', 'a.jpg': 'image/jpeg', 'a.webp': 'image/webp', 'a.ico': 'image/x-icon', 'a.woff2': 'font/woff2', 'a.woff': 'font/woff', 'a.ttf': 'font/ttf', 'a.mp4': 'video/mp4', 'a.jpeg': 'image/jpeg', 'a.zip': 'application/zip', 'a.txt': 'text/plain', 'a.unknown': 'application/octet-stream', 'a.constructor': 'application/octet-stream' })) assert.equal(mimeType(path), expected);
});

test('refuses missing inputs, missing main, duplicate modules and malformed declarations', async t => {
  const root = await fixture(t);
  await assert.rejects(build(root, { workerDirectory: 'absent' }), /ENOENT/);
  await assert.rejects(build(root, { assetsDirectory: 'absent' }), /ENOENT/);
  await assert.rejects(build(root, { mainModule: 'absent.js' }), /entry module/);
  for (const entry of [{ name: 'index.js', path: 'dist/server/index.js', type: 'esm' }, { name: 'extra.js', path: 'dist/server/index.js', type: 'unknown' }, { name: 'extra.js', path: 'dist/server/index.js', type: 'esm', unexpected: true }, { name: 'extra.js', path: 'dist/server/wrangler.json', type: 'text' }]) await assert.rejects(build(root, { additionalModules: [entry] }), /Duplicate|Invalid additional|not deployable/);
  await assert.rejects(build(root, { additionalModules: [{ name: 'extra.js', path: 'absent.js', type: 'esm' }] }), /ENOENT/);
});

test('refuses private and reserved files at every nesting level', async t => {
  const root = await fixture(t);
  for (const path of ['.env', '.env.production', '.dev.vars', '.npmrc', '.yarnrc.yml', '.netrc', '_netrc', '.pypirc', '.git-credentials', '.git/config', '.seed/state', '.wrangler/state', 'node_modules/private.js', 'owner.json', 'credentials.json', 'providers.json', 'secret.pem', 'secret.key', 'release-provenance.json', 'rer-broker-entry.js']) {
    for (const tree of ['dist/server', 'dist/client']) {
      const prefix = `${tree}/nested/private-case`;
      await put(root, `${prefix}/${path}`, 'test-only private fixture');
      await assert.rejects(build(root), /Private or reserved/, path);
      await rm(join(root, prefix), { recursive: true });
    }
  }
  await put(root, 'private/.env', 'test-only fixture');
  await assert.rejects(build(root, { additionalModules: [{ name: 'data.txt', type: 'text', path: 'private/.env' }] }), /Private or reserved/);
  for (const name of ['payload/module.js', 'rer-broker-entry.js', '../escape.js', '/absolute.js', 'a//b.js', 'a\\b.js', 'a"b.js', 'a\nb.js']) await assert.rejects(build(root, { mainModule: name }), /Invalid|Private|Reserved/);
});

test('rejects file, directory, ancestor and excluded-file symlinks', async t => {
  const root = await fixture(t);
  for (const [link, target] of [['dist/server/link.js', 'index.js'], ['dist/server/index.map', 'index.js'], ['dist/server/folder', '../client'], ['dist/client/link', '../server/index.js']]) {
    await symlink(target, join(root, link));
    await assert.rejects(build(root), /symlink/);
    await rm(join(root, link));
  }
  await symlink('dist', join(root, 'linked'));
  await assert.rejects(build(root, { workerDirectory: 'linked/server' }), /symlink/);
  await assert.rejects(build(root, { additionalModules: [{ name: 'extra.js', type: 'esm', path: 'linked/server/index.js' }] }), /symlink/);
  await symlink(root, join(root, 'root-link'));
  await assert.rejects(build(join(root, 'root-link')), /real directory/);
});

test('output freshness, traversal and separation preserve owner files', async t => {
  const root = await fixture(t);
  await put(root, 'occupied/owner.txt', 'keep');
  for (const output of ['occupied/package.json', '../outside/package.json', '/tmp/package.json', 'package.json', 'payload/package.json', '.git/package.json', 'out/release-provenance.json', 'out/not-json.txt', 'dist/server/package.json', 'dist/client/out/package.json']) await assert.rejects(build(root, { output }), /fresh|Invalid|must|Private/);
  assert.equal(await readFile(join(root, 'occupied/owner.txt'), 'utf8'), 'keep');
  await symlink('occupied', join(root, 'linked-output'));
  await assert.rejects(build(root, { output: 'linked-output/new/package.json' }), /real directories/);
  const first = await build(root);
  const before = await snapshot(dirname(first));
  await assert.rejects(build(root), /fresh/);
  assert.deepEqual(await snapshot(dirname(first)), before);
});

test('enforces inclusive entry/count/total bounds and rejects oversized real inputs before output', async t => {
  const entries = Array.from({ length: 4 }, () => ({ size: MAX_ARTIFACT_ENTRY_BYTES }));
  assert.equal(entries.reduce((n, e) => n + e.size, 0), MAX_ARTIFACT_PAYLOAD_BYTES);
  assert.doesNotThrow(() => validatePayloadBounds(entries));
  assert.doesNotThrow(() => validatePayloadBounds(Array.from({ length: MAX_ARTIFACT_ENTRIES }, () => ({ size: 0 }))));
  assert.throws(() => validatePayloadBounds([...entries, { size: 1 }]), /payload exceeds/);
  assert.throws(() => validatePayloadBounds(Array.from({ length: MAX_ARTIFACT_ENTRIES + 1 }, () => ({ size: 0 }))), /too many/);
  const root = await fixture(t);
  await put(root, 'dist/server/large.wasm', '');
  await truncate(join(root, 'dist/server/large.wasm'), MAX_ARTIFACT_ENTRY_BYTES + 1);
  await assert.rejects(build(root), /entry exceeds/);
  await assert.rejects(lstat(join(root, 'delivery-artifact')), { code: 'ENOENT' });
});


test('rejects manifest overflow using real SQL and enforces total/count limits on real files', async t => {
  const root = await fixture(t);
  await put(root, 'dist/server/wrangler.json', JSON.stringify({ compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'test-database', database_id: 'test-only-id', migrations_dir: '../../migrations' }] }));
  await put(root, 'migrations/001-large.sql', '-- ' + 'x'.repeat(4 * 1024 * 1024));
  await assert.rejects(build(root), /manifest exceeds/);
  await assert.rejects(lstat(join(root, 'delivery-artifact/rer-worker-artifact.json')), { code: 'ENOENT' });
  await rm(join(root, 'migrations'), { recursive: true });
  await put(root, 'dist/server/wrangler.json', JSON.stringify({ compatibility_date: '2026-09-01' }));
  // Sparse test-only files exercise preflight without reading 96 MiB.
  for (let i = 0; i < 4; i++) {
    await put(root, `dist/server/large-${i}.wasm`, '');
    await truncate(join(root, `dist/server/large-${i}.wasm`), MAX_ARTIFACT_ENTRY_BYTES);
  }
  await assert.rejects(build(root), /payload exceeds/);
  for (let i = 0; i < 4; i++) await rm(join(root, `dist/server/large-${i}.wasm`));
  for (let i = 0; i < MAX_ARTIFACT_ENTRIES; i++) await put(root, `dist/client/file-${i}.txt`, '');
  await assert.rejects(build(root), /too many/);
});

test('supports explicitly typed binary modules and custom build locations', async t => {
  const root = await fixture(t);
  await put(root, 'worker/entry.cjs', 'module.exports = {};');
  await put(root, 'static/data.bin', Buffer.from([0, 255]));
  await put(root, 'source/blob.bin', Buffer.from([128, 0, 1]));
  const path = await build(root, { workerDirectory: 'worker', assetsDirectory: 'static', mainModule: 'entry.cjs', additionalModules: [{ name: 'blob.bin', path: 'source/blob.bin', type: 'buffer' }] });
  const data = await manifest(path);
  assert.deepEqual(data.modules.map(m => m.type), ['buffer', 'commonjs']);
  assert.equal(data.assets[0].contentType, 'application/octet-stream');
});

// Opt-in independent compatibility check against a real service source checkout.
// The caller supplies the pinned public source; no parser replacement is used.
test('real service parser and archive inspector accept exact bytes and reject payload tampering', { skip: !process.env.DELIVERY_SERVICE_ROOT }, async t => {
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (!specifier.startsWith('.')) throw error;
      if (error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return nextResolve(`${specifier}/index.ts`, context);
      if (error.code === 'ERR_MODULE_NOT_FOUND') return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  }, load(url, context, nextLoad) {
    return nextLoad(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);
  } });
  t.after(() => hooks.deregister());
  const { validateArtifactPackageManifest, inspectAcceptedArtifact } = await import(pathToFileURL(join(process.env.DELIVERY_SERVICE_ROOT, 'src/delivery/artifact-package.ts')).href);
  const root = await fixture(t);
  await put(root, 'dist/server/module.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const path = await build(root);
  const data = await manifest(path);
  assert.deepEqual(validateArtifactPackageManifest(data), data);
  const { validateCandidateSpec } = await import(pathToFileURL(join(process.env.DELIVERY_SERVICE_ROOT, 'src/delivery/candidate-plan.ts')).href);
  await validateCandidateSpec(data.deploymentSpec);
  const files = await snapshot(dirname(path));
  const artifactFile = 'rer-worker-artifact.json';
  // This test-only receipt supplies identity to the real inspector. Production
  // receipts are exclusively authored by independent workflow attestation.
  const identity = { repositoryId: '1', ownerId: '2', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), sourceLockSha256: 'c'.repeat(64), artifactSha256: digest(files[artifactFile]), artifactId: '3', runId: '4', runAttempt: '1', workflowRef: 'example/delivery/.github/workflows/trusted-build.yml@' + 'd'.repeat(40) };
  files['release-provenance.json'] = Buffer.from(JSON.stringify({ schema: 2, artifactSchema: 2, artifactFile, ...identity }));
  const accepted = await inspectAcceptedArtifact(storedZip(files), identity, artifactFile);
  assert.equal(accepted.format, 'package-zip');
  for (const entry of data.modules) assert.deepEqual(Buffer.from(await accepted.source.readModule(entry.name)), files[entry.payload]);
  for (const entry of data.assets) assert.deepEqual(Buffer.from(await accepted.source.readAsset(entry.path)), files[entry.payload]);
  const payload = data.modules[0].payload;
  const changed = Buffer.from(files[payload]); changed[0] ^= 1;
  await assert.rejects(inspectAcceptedArtifact(storedZip({ ...files, [payload]: changed }), identity, artifactFile), /integrity mismatch/);
});

// Minimal standard stored ZIP writer for this independent service test. It
// copies the producer's real files unchanged and supplies ordinary ZIP CRCs.
function storedZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [path, bytes] of Object.entries(files)) {
    const name = Buffer.from(path);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
