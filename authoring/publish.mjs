import { cp, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkOrigin, git, mainSha } from './git.mjs';
import { publication } from './publication.mjs';
import { files, validateTree } from './tree.mjs';

export async function publish({ source, target, family, sha, edition, check = false }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(edition ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('Expected edition ID and full family SHA');
  [source, target, family] = await Promise.all([source, target, family].map(path => realpath(path)));
  for (const a of [source, family]) {
    for (const [first, second] of [[a, target], [target, a]]) {
      const rel = relative(first, second);
      if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
        throw new Error('Source, family and target must not overlap');
    }
  }
  const { descriptor, repository } = publication(family, sha, edition);
  checkOrigin(target, repository);
  checkOrigin(family, descriptor.repository);
  if (git(target, 'status', '--porcelain', '--untracked-files=all', '--ignored')) throw new Error('Target checkout is dirty');
  await validateTree(source, edition, descriptor.repository, sha, descriptor.base);
  const remoteHead = mainSha(target);
  let head = '';
  try { head = git(target, 'rev-parse', '--verify', 'HEAD'); } catch { /* An empty upstream can be bootstrapped. */ }
  if (head !== remoteHead) throw new Error('Target HEAD is not current upstream main');
  if (head) {
    const previous = await validateTree(target, edition, descriptor.repository);
    git(family, 'merge-base', '--is-ancestor', previous.repositories.family.commit, sha);
  }
  else if ((await files(target)).length) throw new Error('Empty target contains unexpected files');
  if (mainSha(family) !== sha) throw new Error('Family main advanced; refusing stale publication');
  if (check) return { checked: true };
  for (const name of await readdir(target)) {
    if (name !== '.git') await rm(resolve(target, name), { recursive: true, force: true });
  }
  for (const name of await readdir(source)) {
    if (name !== '.git') await cp(resolve(source, name), resolve(target, name), { recursive: true });
  }
  git(target, 'add', '-f', '-A');
  if (!git(target, 'diff', '--cached', '--name-only')) return { changed: false };
  git(target, '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `Generate ${edition} from ${descriptor.id} ${sha}`);
  // Recheck both branches immediately before the ordinary non-forced push.
  if (mainSha(family) !== sha) throw new Error('Family main advanced; refusing stale publication');
  if (mainSha(target) !== remoteHead) throw new Error('Target main advanced; refusing publication');
  git(target, 'push', 'origin', 'HEAD:refs/heads/main');
  return { changed: true, commit: git(target, 'rev-parse', 'HEAD') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { ...Object.fromEntries(
    ['source', 'target', 'family', 'sha', 'edition'].map(name => [name, { type: 'string' }]),
  ), check: { type: 'boolean', default: false } } });
  try { console.log(JSON.stringify(await publish(values))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
