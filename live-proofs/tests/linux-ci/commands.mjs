import { spawn } from 'node:child_process';
export class Incomplete extends Error {}
// No inherited provider, Git, npm or Actions token environment reaches a command.
export function cleanEnvironment(root, path = process.env.PATH) {
  return { PATH: path, HOME: root, TMPDIR: root, RUNNER_TEMP: root, CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', DOCKER_CONFIG: root + '/docker-config',
    WRANGLER_SEND_METRICS: 'false', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
}
export function execute(argv, { cwd, env, input, timeout = 900000, limit = 32 * 1024 * 1024 } = {}) {
  const startedUtc = new Date().toISOString();
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; let size = 0, timedOut = false, overflow = false, spawnError;
    const kill = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') spawnError ??= e.code; } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    const collect = list => chunk => { size += chunk.length; if (size > limit) { overflow = true; kill(); } else list.push(chunk); };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    child.on('error', e => { spawnError = e.code; }); child.stdin.on('error', () => {}); child.stdin.end(input);
    child.once('close', code => { clearTimeout(timer); kill(); resolve({ argv, cwd, startedUtc, finishedUtc: new Date().toISOString(),
      exitCode: Number.isInteger(code) ? code : -1, timedOut, overflow, spawnError,
      stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); });
  });
}
export function assertExecution(result) {
  if (result.timedOut || result.spawnError) throw new Incomplete('command-unavailable-or-timeout');
  if (result.overflow) throw new Error('command-output-limit');
  if (result.exitCode !== 0) throw new Error('command-exit-' + result.exitCode);
  return result;
}
