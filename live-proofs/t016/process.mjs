import { spawn } from 'node:child_process';
import { digest } from '../../scripts/qualification/operations.mjs';

export function runProcess(argv, { cwd, env, input, timeout = 900000, limit = 256 * 1024 * 1024 } = {}) {
  const startedUtc = new Date().toISOString();
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = []; let size = 0, killed = false;
    const stop = () => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(stop, timeout);
    const receive = destination => bytes => { size += bytes.length; if (size > limit) stop(); else destination.push(bytes); };
    child.stdout.on('data', receive(chunks)); child.stderr.on('data', receive(errors));
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', stop);
    child.on('close', code => {
      clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      const output = Buffer.concat(chunks), stderr = Buffer.concat(errors);
      resolve({ exitCode: killed ? -1 : (code ?? -1), output, stderr, startedUtc,
        finishedUtc: new Date().toISOString(), outputHash: digest(Buffer.concat([output, stderr])) });
    });
  });
}
