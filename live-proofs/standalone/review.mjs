import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { join, posix } from 'node:path';
import { runProcess } from '../t016/process.mjs';
import { digest, insist, resolveCommand } from '../../scripts/qualification/operations.mjs';

export function sourcePath(value, dot = false) {
  // Git filenames are literal data, including native route punctuation and
  // Unicode. Reject ambiguous paths instead of rewriting or shell-escaping them.
  insist(typeof value === 'string' && value.isWellFormed() && !/[\p{Cc}\\]/u.test(value) &&
    !/^[A-Za-z]:/.test(value) && ((dot && value === '.') ||
    value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git')), 'unsafe-source-path');
  return value;
}
export const containerCwd = cwd => posix.join('/seed', sourcePath(cwd ?? '.', true));
export function credentialNames(names) {
  insist(Array.isArray(names) && new Set(names).size === names.length && names.every(name =>
    typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(name) &&
    !/^(?:EVIDENCE_|GH_|GITHUB_|NODE_|NPM_|PNPM_|GIT_|BASH_|LD_|DYLD_|DOCKER_|QUALIFICATION_|T016_|ENV$|BASH_ENV$|PATH$|HOME$|TMPDIR$|PYTHONPATH$|PYTHONHOME$)/.test(name)), 'invalid-credential-contract');
  return names;
}
export function reviewDescriptor(descriptor, adapter, remoteSelection) {
  insist(adapter && /^[a-f0-9]{40}$/.test(adapter.sourceSha ?? '') &&
    adapter.descriptorSha256 === digest(descriptor), 'unreviewed-descriptor');
  const names = credentialNames(adapter.requiredEnvironment);
  insist(credentialNames(descriptor.requiredEnvironment ?? []).every(name => names.includes(name)), 'unreviewed-credentials');
  insist(Array.isArray(adapter.deploymentEnvironment) && adapter.deploymentEnvironment.every(name => names.includes(name)) &&
    (descriptor.requiredEnvironment ?? []).every(name => adapter.deploymentEnvironment.includes(name)), 'unreviewed-deployment-environment');
  const commands = ['setup', 'deploy'].map(name => ({ name, argv: resolveCommand(descriptor, name, remoteSelection),
    cwd: sourcePath(descriptor.commands[name].cwd ?? '.', true) }));
  insist(adapter.controllerFiles && Object.keys(adapter.controllerFiles).length > 0 &&
    Object.entries(adapter.controllerFiles).every(([path, hash]) => sourcePath(path) && /^[a-f0-9]{64}$/.test(hash)), 'unreviewed-controller-files');
  const directories = adapter.controllerDirectories ?? [];
  insist(Array.isArray(directories) && new Set(directories).size === directories.length && directories.every(path =>
    sourcePath(path) && !Object.keys(adapter.controllerFiles).some(file => path === file || path.startsWith(file + '/'))), 'unreviewed-controller-directories');
  insist(Array.isArray(adapter.builds) && adapter.builds.length > 0 && typeof adapter.validateArtifact === 'function', 'unreviewed-build');
  for (const build of adapter.builds) {
    for (const argv of [build.argv, ...(build.install ?? [])]) insist(Array.isArray(argv) && argv.length > 0 &&
      argv.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')), 'invalid-build-command');
    insist(/^[a-zA-Z0-9_-]+$/.test(build.argv[0]), 'invalid-routed-executable');
    sourcePath(build.cwd ?? '.', true); sourcePath(build.output);
    insist(![...Object.keys(adapter.controllerFiles), ...directories].some(path => path === build.output ||
      path.startsWith(build.output + '/') || build.output.startsWith(path + '/')), 'artifact-controller-overlap');
    insist(Array.isArray(build.publicEnvironment ?? []) && (build.publicEnvironment ?? []).every(name =>
      adapter.deploymentEnvironment.includes(name) && !/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/.test(name)), 'unreviewed-public-environment');
    // Only explicitly reviewed public inputs reach this mapper, never authority.
    insist(typeof build.environment === 'function' || (build.environment && Object.entries(build.environment).every(([key, value]) =>
      credentialNames([key]) && typeof value === 'string')), 'unreviewed-build-environment');
  }
  for (const name of new Set(adapter.builds.map(build => build.argv[0]))) {
    const tool = adapter.tools?.[name];
    insist(tool && /^\/(?:opt|usr)\/[A-Za-z0-9_./-]+$/.test(tool.path) && !tool.path.includes('..') &&
      Array.isArray(tool.allow) && tool.allow.every(argv => Array.isArray(argv) && argv.length && argv.every(arg => typeof arg === 'string' && arg.length)), 'unreviewed-tool');
  }
  insist(typeof adapter.qualify === 'function' && Array.isArray(adapter.journeyEnvironment) &&
    adapter.journeyEnvironment.every(name => names.includes(name)), 'unreviewed-journey');
  return { commands, names };
}

// Read immutable Git objects, not a possibly dirty checkout, ignored env files,
// installed packages, symlinks or a worktree's pointer to the shared Git store.
export async function snapshotSource({ directory, sourceSha, destination, env }) {
  env = { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const git = async args => {
    const result = await runProcess(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: directory, env });
    insist(result.exitCode === 0, 'source-snapshot-failed'); return result.output;
  };
  insist((await git(['rev-parse', 'HEAD'])).toString().trim() === sourceSha, 'source-revision-mismatch');
  const tree = await git(['ls-tree', '-rz', '--full-tree', sourceSha]);
  // Lossy decoding could rename a Git entry or make two different paths alias.
  insist(isUtf8(tree), 'unsafe-source-path');
  const entries = tree.toString().split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);
    insist(match, 'source-nonregular-file');
    return { mode: match[1] === '100755' ? 0o755 : 0o644, hash: match[2], path: sourcePath(match[3]) };
  });
  insist(entries.length > 0 && entries.length <= 20000, 'source-file-limit');
  const result = await runProcess(['git', 'cat-file', '--batch'], { cwd: directory, env, input: entries.map(x => x.hash).join('\n') + '\n' });
  insist(result.exitCode === 0, 'source-snapshot-failed');
  let offset = 0; mkdirSync(destination, { mode: 0o755 });
  for (const entry of entries) {
    const end = result.output.indexOf(10, offset), header = result.output.subarray(offset, end).toString();
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
    insist(end >= offset && match?.[1] === entry.hash, 'invalid-source-object');
    const size = Number(match[2]); offset = end + 1;
    insist(size <= 64 * 1024 * 1024 && offset + size < result.output.length && result.output[offset + size] === 10, 'source-object-limit');
    mkdirSync(join(destination, entry.path, '..'), { recursive: true, mode: 0o755 });
    writeFileSync(join(destination, entry.path), result.output.subarray(offset, offset + size), { mode: entry.mode, flag: 'wx' });
    offset += size + 1;
  }
  insist(offset === result.output.length, 'invalid-source-object');
}
function sourceEntry(source, path, directory) {
  sourcePath(path);
  const failure = directory ? 'controller-directory-mismatch' : 'controller-file-mismatch';
  insist(lstatSync(source).isDirectory(), failure);
  const parts = path.split('/'); let current = source, entry;
  for (const [index, part] of parts.entries()) {
    current = join(current, part); entry = lstatSync(current);
    insist(index < parts.length - 1 || directory ? entry.isDirectory() : entry.isFile(), failure);
  }
  return entry;
}
export function copyControllerFiles(source, destination, files, directories = []) {
  mkdirSync(destination, { mode: 0o755 });
  // Reviewed structure is explicit and carries no recursive source authority.
  // In particular, a migration collector may require an empty module root.
  for (const path of directories) {
    sourceEntry(source, path, true);
    mkdirSync(join(destination, path), { recursive: true, mode: 0o755 });
  }
  for (const [path, hash] of Object.entries(files)) {
    const entry = sourceEntry(source, path, false), bytes = readFileSync(join(source, path));
    insist(digest(bytes) === hash, 'controller-file-mismatch');
    mkdirSync(join(destination, path, '..'), { recursive: true, mode: 0o755 });
    writeFileSync(join(destination, path), bytes, { flag: 'wx', mode: entry.mode & 0o777 });
  }
}
