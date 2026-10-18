import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicGit, publicOid } from './public-git.mjs';
import { githubSource } from './github-verify.mjs';
import { releaseMessage } from './export.mjs';

function remoteObject(repo, url, ref) {
  const rows = publicGit(repo, ['--git-dir=/dev/null', 'ls-remote', '--refs', '--', url, ref])
    .toString().trim().split('\n').filter(Boolean);
  if (!rows.length) return null;
  const [oid, name, extra] = rows[0].split('\t');
  if (rows.length !== 1 || name !== ref || extra !== undefined || !/^[a-f0-9]{40}$/.test(oid))
    throw Error('Remote release tag is ambiguous');
  return oid;
}

function referenceObject(repo, ref) {
  const prefix = `${ref} `;
  const row = publicOid(repo, 'for-each-ref', '--format=%(refname) %(objectname)', ref)
    .split('\n').find(line => line.startsWith(prefix));
  return row ? row.slice(prefix.length) : null;
}

function tagObject(repo, ref, object, commit, reason) {
  if (referenceObject(repo, ref) !== object) throw Error(reason);
  if (publicOid(repo, 'cat-file', '-t', object) !== 'tag')
    throw Error('Existing release tag must be an annotated tag object');
  const raw = publicGit(repo, ['cat-file', 'tag', object]);
  // Check the bytes too: the build has write access to this object store.
  if (publicGit(repo, ['hash-object', '-t', 'tag', '--stdin'], raw).toString().trim() !== object)
    throw Error(reason);
  const split = raw.indexOf('\n\n');
  const headers = raw.subarray(0, split).toString('utf8').split('\n');
  if (split < 0 || headers[0] !== `object ${commit}` || headers[1] !== 'type commit' ||
      publicOid(repo, 'rev-parse', `${ref}^{commit}`) !== commit)
    throw Error('Existing annotated tag must point directly at the exact source commit');
  return { raw, split, headers };
}

// Inspect the published object in isolation. Never retarget a local or remote
// tag, and never use the presence of a tag as verification evidence.
export function prepareTagAdoption(source, checkout) {
  const ref = `refs/tags/${source.tag}`;
  const local = referenceObject(source.repo, ref);
  const repository = githubSource(source);
  if (!repository) {
    if (local) throw Error('Release tag already exists; adoption requires its remote GitHub source tag');
    return null;
  }
  const url = `https://github.com/${repository}`;
  const object = remoteObject(source.repo, url, ref);
  if (!object) {
    if (local) throw Error('Release tag already exists locally but is not published at the source repository');
    return null;
  }
  if (local && local !== object)
    throw Error('Local and remote release tag objects differ');
  const stagedRef = 'refs/rer-release/adopted-tag';
  publicGit(checkout, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', url, `${ref}:${stagedRef}`]);
  const { raw, split, headers } = tagObject(checkout, stagedRef, object, source.commit, 'Remote release tag changed during inspection');
  if (headers[2] !== `tag ${source.tag}`) throw Error('Existing annotated tag name must match the committed release version');
  if (!raw.subarray(split + 2).equals(Buffer.from(releaseMessage(source) + '\n')))
    throw Error('Existing annotated tag message must exactly match the release message');
  return Object.freeze({ repo: checkout, url, ref, stagedRef, object, commit: source.commit, local });
}

// The captured identity survives arbitrary ref changes by the source build.
// The producer also calls this after artifact creation, before returning RELEASED.
export function assertTagAdoption(source, adopted, { imported = false } = {}) {
  if (source.commit !== adopted.commit || `refs/tags/${source.tag}` !== adopted.ref)
    throw Error('Release source changed during tag adoption');
  tagObject(adopted.repo, adopted.stagedRef, adopted.object, adopted.commit, 'Staged release tag changed during release');
  if (remoteObject(source.repo, adopted.url, adopted.ref) !== adopted.object)
    throw Error('Remote release tag changed during release');
  const local = referenceObject(source.repo, adopted.ref);
  if ((local && local !== adopted.object) || ((adopted.local || imported) && !local))
    throw Error('Local release tag changed during release');
  if (local) tagObject(source.repo, adopted.ref, adopted.object, adopted.commit, 'Local release tag changed during release');
  return local;
}

export function confirmTagAdoption(source, adopted) {
  const local = assertTagAdoption(source, adopted);
  if (!local) {
    const importedRef = `refs/rer-release/imported-tag-${randomUUID()}`;
    try {
      // Never fetch a build-controlled ref directly into the source tag.
      publicGit(source.repo, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--',
        resolve(adopted.repo), `${adopted.object}:${importedRef}`]);
      tagObject(source.repo, importedRef, adopted.object, adopted.commit, 'Imported release tag changed during release');
      assertTagAdoption(source, adopted);
      // The missing-tag snapshot is the expected old value, including when a
      // concurrent writer creates the same object while the import runs.
      publicGit(source.repo, ['update-ref', '--no-deref', adopted.ref, adopted.object, '0'.repeat(40)]);
    } finally {
      publicGit(source.repo, ['update-ref', '--no-deref', '-d', importedRef]);
    }
  }
  assertTagAdoption(source, adopted, { imported: true });
}
