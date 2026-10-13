import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
export const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
export function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim();
}
export function fixture(t) {
  const root = mkdtempSync(resolve('live-proofs/tests/.fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); mkdirSync(source);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'README'), 'initial\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'initial');
  const sha = git(source, 'rev-parse', 'HEAD');
  const remote = join(root, 'remote.git'); git(root, 'clone', '--bare', source, remote);
  const controller = join(root, 'controller'); git(root, 'clone', remote, controller);
  return { root, source, sha, remote, controller };
}
export function commit(source, name, content = name) {
  writeFileSync(join(source, name), content); git(source, 'add', '.'); git(source, 'commit', '-m', name);
  return git(source, 'rev-parse', 'HEAD');
}
export function wrapper(root, body) {
  const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node\nimport {spawnSync,execFileSync} from 'node:child_process';\nimport fs from 'node:fs';\nconst real=${JSON.stringify(realGit)};const args=process.argv.slice(2);\n${body}\nconst r=spawnSync(real,args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
export function cli(file, env, cwd = process.cwd()) {
  return spawnSync(process.execPath, [file], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}
