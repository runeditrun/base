import { execFileSync } from 'node:child_process';

export const git = (cwd, ...args) => execFileSync('git', ['--no-replace-objects', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
const allowedOrigin = (url, repository) => [
  `https://github.com/${repository}`, `https://github.com/${repository}.git`,
  `git@github.com:${repository}`, `git@github.com:${repository}.git`,
  `ssh://git@github.com/${repository}`, `ssh://git@github.com/${repository}.git`,
].includes(url);

export function checkOrigin(directory, repository) {
  if (!allowedOrigin(git(directory, 'config', '--get', 'remote.origin.url'), repository))
    throw new Error(`Origin must be ${repository}`);
  const config = git(directory, 'config', '--get-regexp', '^remote\\.origin\\.');
  for (const line of config.split('\n')) {
    if (line.startsWith('remote.origin.pushurl ') && !allowedOrigin(line.slice('remote.origin.pushurl '.length), repository))
      throw new Error('Unexpected push URL');
    if (line === 'remote.origin.mirror true') throw new Error('Mirror push is forbidden');
  }
}


export function mainSha(directory) {
  return git(directory, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
}
