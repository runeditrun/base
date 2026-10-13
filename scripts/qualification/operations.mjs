import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function insist(condition, code) { if (!condition) throw new Error(code); }
export function readOperations(directory) {
  const root = realpathSync(directory);
  const file = realpathSync(resolve(root, 'OPERATIONS.json'));
  insist(!relative(root, file).startsWith('..'), 'descriptor-escape');
  const descriptor = JSON.parse(readFileSync(file, 'utf8'));
  insist([1, 2].includes(descriptor.version) && descriptor.commands && typeof descriptor.commands === 'object', 'invalid-descriptor');
  return descriptor;
}

// OPERATIONS v1/v2 specify argv, never implicit shell strings. An explicitly
// declared ["sh", "-c", ...] retains those exact shell semantics.
export function resolveCommand(descriptor, name, remoteSelection) {
  const command = descriptor.commands?.[name];
  insist(command && Array.isArray(command.argv) && command.argv.length > 0 && command.argv.length <= 100 &&
    command.argv.every(x => typeof x === 'string' && x.length > 0 && x.length <= 8192 && !x.includes('\0')), 'invalid-command');
  const argv = [...command.argv];
  if (remoteSelection) {
    const { from, to } = remoteSelection;
    insist(from === '--local' && to === '--remote' && argv.filter(x => x === from).length === 1 &&
      typeof command.effects === 'string' && /--remote\b/.test(command.effects), 'undeclared-remote-target');
    argv[argv.indexOf(from)] = to;
  }
  insist(!argv.some(x => /(?:^|\s)(?:--local|--dry-run|--plan)(?:\s|$|=)/.test(x)), 'local-target-refused');
  insist(argv.includes('--remote') || /(?:^|\s)--remote(?:\s|$)/.test(argv.join(' ')) || command.target === 'remote', 'remote-target-undeclared');
  return argv;
}

export function executeCommand(argv, { cwd, env, timeout = 15 * 60 * 1000 }) {
  const startedUtc = new Date().toISOString();
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, detached: process.platform !== 'win32' });
  // Terminate any descendants left by a timed-out package/build command too.
  if (process.platform !== 'win32' && result.pid) { try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  // Provider output remains in memory only. Never echo error messages or output.
  return { cwd, startedUtc, finishedUtc: new Date().toISOString(), commandHash: digest(argv),
    exitCode: Number.isInteger(result.status) ? result.status : -1,
    outputHash: digest(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

export function deployDescriptor({ cwd, env, remoteSelection, observe = () => {} }) {
  const descriptor = readOperations(cwd);
  // Legacy local command-library callers are credential-free smoke checks.
  // Hosted/credential-bearing qualification must use the reviewed executor.
  const localNames = ['PATH', 'HOME', 'TMPDIR', 'CI', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'];
  insist((descriptor.requiredEnvironment ?? []).length === 0 && env &&
    Object.keys(env).every(name => localNames.includes(name)), 'reviewed-executor-required');
  // Resolve both before doing any effect, so a bad deploy command cannot leave
  // a half-provisioned target merely because validation happened too late.
  const commands = ['setup', 'deploy'].map(name => ({ name, argv: resolveCommand(descriptor, name, remoteSelection) }));
  for (const { name, argv } of commands) {
    const result = executeCommand(argv, { cwd, env });
    observe(name, result);
    insist(result.exitCode === 0, `${name}-failed`);
  }
  return descriptor;
}
