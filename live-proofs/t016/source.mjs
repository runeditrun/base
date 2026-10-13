import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeCommand, digest, insist } from '../../scripts/qualification/operations.mjs';
import { publicSource } from './profile.mjs';

export function git(cwd, argv, env, record = () => {}) {
  const result = executeCommand(['git', '-c', 'core.hooksPath=/dev/null', ...argv], { cwd, env });
  record(['git', '-c', 'core.hooksPath=/dev/null', ...argv], result);
  insist(result.exitCode === 0, 'public-source-failed');
  return result.output.trim();
}
export function acquirePublic(root, env, previous = false, record = () => {}) {
  const cwd = join(root, 'seed');
  git(root, ['clone', '--no-checkout', '--no-tags', publicSource.repository, 'seed'], env, record);
  for (const [ref, sha] of [[publicSource.ref, publicSource.sha], [publicSource.previousRef, publicSource.previousSha]]) {
    git(cwd, ['fetch', '--no-tags', 'origin', `refs/tags/${ref}:refs/tags/${ref}`], env, record);
    insist(git(cwd, ['rev-parse', `${ref}^{commit}`], env, record) === sha, 'public-tag-mismatch');
  }
  const sha = previous ? publicSource.previousSha : publicSource.sha;
  git(cwd, ['checkout', '--detach', sha], env, record);
  return { cwd, sha, documentsHash: digest(['OPERATIONS.json', 'OPERATIONS.md', 'ACCEPTANCE.md', 'docs/INSTALLER.md']
    .map(path => [path, digest(readFileSync(join(cwd, path)))])) };
}
