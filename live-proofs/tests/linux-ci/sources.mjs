import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { snapshotSource } from '../../standalone/review.mjs';
import { command } from './docker.mjs';
import { manifest, hash } from './receipt.mjs';
import { Incomplete } from './commands.mjs';
import { publicSnapshot } from './public-snapshot.mjs';
export async function acquire(ctx, pin) {
  const root = join(ctx.root, pin.id); mkdirSync(root); const repository = join(root, 'git');
  const git = args => command(ctx, ['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root }, ['public-sources']);
  const advertised = await git(['ls-remote', 'https://github.com/just-every/happytohelp.git', 'refs/tags/' + pin.tag, 'refs/tags/' + pin.tag + '^{}']).catch(e => { throw new Incomplete(e.message); });
  const refs = Object.fromEntries(advertised.stdout.toString().trim().split('\n').filter(Boolean).map(s => s.split(/\s+/).reverse()));
  assert(refs['refs/tags/' + pin.tag], 'missing-public-tag');
  await git(['clone', '--no-checkout', '--no-tags', 'https://github.com/just-every/happytohelp.git', repository]).catch(e => { throw new Incomplete(e.message); });
  await git(['-C', repository, 'fetch', '--no-tags', 'origin', 'refs/tags/' + pin.tag + ':refs/tags/' + pin.tag]);
  const peeled = (await git(['-C', repository, 'rev-parse', pin.tag + '^{commit}'])).stdout.toString().trim(); assert.equal(peeled, pin.sha);
  const tagObject = (await git(['-C', repository, 'rev-parse', pin.tag])).stdout.toString().trim(); assert.equal(tagObject, refs['refs/tags/' + pin.tag]);
  if (refs['refs/tags/' + pin.tag + '^{}']) assert.equal(refs['refs/tags/' + pin.tag + '^{}'], pin.sha);
  await git(['-C', repository, 'checkout', '--detach', pin.sha]);
  const tree = (await git(['-C', repository, 'rev-parse', pin.sha + '^{tree}'])).stdout.toString().trim();
  // Binary archive never goes through text command logging.
  const { execute, assertExecution } = await import('./commands.mjs');
  const archive = assertExecution(await execute(['git', '-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', pin.sha], { cwd: repository, env: ctx.env, limit: 128 * 1024 * 1024 }));
  const archiveHash = hash(archive.stdout);
  ctx.receipt.command({ ...archive, stdout: Buffer.from(JSON.stringify({ bytes: archive.stdout.length, sha256: archiveHash })) }, ['archives']);
  assert.equal(archiveHash, pin.archive, 'public-git-archive-format-or-source-mismatch');
  ctx.receipt.file('sources/' + pin.id + '.tar.gz', gzipSync(archive.stdout), ['archives', 'public-sources']);
  const source = join(root, 'source');
  const verifiedBlobs = await publicSnapshot(ctx, repository, pin.sha, source);
  const files = manifest(source);
  assert.deepEqual([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), verifiedBlobs.map(({ gitBlob, ...file }) => file).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  ctx.receipt.file('sources/' + pin.id + '-git-blobs.json.gz', gzipSync(JSON.stringify(verifiedBlobs, null, 2) + '\n', { level: 9 }), ['public-sources']);
  // Keep this distinct acceptance failure visible. Independent native-build
  // input materialization must not make the actual controller path green.
  const controllerCompatible = await ctx.receipt.proof('h2h-' + pin.id + '-controller-source', () => snapshotSource({ directory: repository, sourceSha: pin.sha, destination: join(root, 'controller-snapshot'), env: ctx.env }));
  if (!controllerCompatible) ctx.receipt.file('sources/' + pin.id + '-controller-source-failure.json', {
    sourceSha: pin.sha, command: 'snapshotSource({directory: public Git checkout, sourceSha, destination, env})',
    offendingPaths: files.filter(f => !/^[A-Za-z0-9_@.+ -]+(?:\/[A-Za-z0-9_@.+ -]+)*$/.test(f.path)).map(f => f.path),
    requirement: 'Fresh scoped repair and independent gate of production snapshotSource; independent materialization proves only native build/handoff',
  }, ['failure-observations', 'public-sources']);
  const documents = ['OPERATIONS.json', 'OPERATIONS.md', 'ACCEPTANCE.md', 'docs/INSTALLER.md', 'package.json', 'pnpm-lock.yaml', 'wrangler.jsonc', 'vite.config.ts'];
  const hashes = Object.fromEntries(documents.map(path => [path, hash(readFileSync(join(source, path)))]));
  ctx.receipt.file('sources/' + pin.id + '.json.gz', gzipSync(JSON.stringify({ ...pin, tagObject, advertised: refs, peeled, tree, archiveSha256: archiveHash, files, documents: hashes }, null, 2) + '\n', { level: 9 }), ['public-sources', 'archives']);
  ctx.sources[pin.id] = { ...pin, root, repository, source, files };
}
