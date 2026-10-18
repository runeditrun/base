import { resolve } from 'node:path';
import { git } from './source.mjs';
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

// Inspect the published object in isolation. Never retarget a local or remote
// tag, and never use the presence of a tag as verification evidence.
export function prepareTagAdoption(source, checkout) {
  const ref = `refs/tags/${source.tag}`;
  const local = git(source.repo, 'tag', '--list', source.tag).toString().trim();
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
  if (local && publicOid(source.repo, 'rev-parse', ref) !== object)
    throw Error('Local and remote release tag objects differ');
  const stagedRef = 'refs/rer-release/adopted-tag';
  publicGit(checkout, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', url, `${ref}:${stagedRef}`]);
  if (publicOid(checkout, 'rev-parse', stagedRef) !== object) throw Error('Remote release tag changed during inspection');
  if (publicOid(checkout, 'cat-file', '-t', object) !== 'tag') throw Error('Existing release tag must be an annotated tag object');
  const raw = publicGit(checkout, ['cat-file', 'tag', object]);
  const split = raw.indexOf('\n\n');
  const headers = raw.subarray(0, split).toString('utf8').split('\n');
  if (split < 0 || headers[0] !== `object ${source.commit}` || headers[1] !== 'type commit')
    throw Error('Existing annotated tag must point directly at the exact source commit');
  if (headers[2] !== `tag ${source.tag}`) throw Error('Existing annotated tag name must match the committed release version');
  if (!raw.subarray(split + 2).equals(Buffer.from(releaseMessage(source) + '\n')))
    throw Error('Existing annotated tag message must exactly match the release message');
  return { repo: checkout, url, ref, stagedRef, object };
}

export function confirmTagAdoption(source, adopted) {
  if (remoteObject(source.repo, adopted.url, adopted.ref) !== adopted.object)
    throw Error('Remote release tag changed during release');
  const local = git(source.repo, 'tag', '--list', source.tag).toString().trim();
  if (local && publicOid(source.repo, 'rev-parse', adopted.ref) !== adopted.object)
    throw Error('Local release tag changed during release');
  if (!local) publicGit(source.repo, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--',
    resolve(adopted.repo), `${adopted.stagedRef}:${adopted.ref}`]);
}
