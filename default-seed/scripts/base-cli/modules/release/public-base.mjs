import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { git } from './source.mjs';
import { publicGit } from './public-git.mjs';

const identity = url => /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+)$/i
  .exec(url)?.[1].replace(/\.git$/i, '');

// Publication targets do not establish whether the source is already public.
// Infer a base from the source repository's own confirmed public origin.
export function releasePublicBase(source, explicit) {
  if (explicit !== undefined) return explicit;
  if (!git(source.repo, 'remote').toString().trim().split('\n').includes('origin')) return undefined;
  const origin = git(source.repo, 'config', '--get', 'remote.origin.url').toString().trim();
  const sourceIdentity = identity(origin);
  if (!sourceIdentity) return undefined;
  const repository = `https://github.com/${sourceIdentity}`;
  const script = 'import sys; sys.path.insert(0, sys.argv[1]); from github_refs import GitHubResolver; print(GitHubResolver().resolve(sys.argv[2]))';
  const visibility = execFileSync('python3', ['-B', '-c', script,
    resolve(import.meta.dirname, '../../scripts/publish-check'), sourceIdentity],
  { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  if (['private', 'missing'].includes(visibility)) return undefined;
  if (visibility !== 'public') throw Error('Source repository visibility could not be established');
  const advertised = publicGit(source.repo, ['--git-dir=/dev/null', 'ls-remote', '--symref', '--', repository, 'HEAD']).toString();
  const branches = [...advertised.matchAll(/^ref: refs\/heads\/(.+)\tHEAD$/gm)].map(match => match[1]);
  if (branches.length !== 1) throw Error('Public source default branch is missing or ambiguous');
  publicGit(source.repo, ['check-ref-format', `refs/heads/${branches[0]}`]);
  return `${repository}#${branches[0]}`;
}
