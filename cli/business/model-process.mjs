import { spawn } from 'node:child_process';

// CLI packages can wrap a native binary in Node. Bound and cancel the private
// process group, so the native classifier cannot outlive a killed wrapper.
// onSpawn receives the new group's id before any output is read.
export async function execute(path, args, { cwd, input, signal, timeout = 120_000, env, limit = 65536, onSpawn }) {
 signal?.throwIfAborted();
 return new Promise((resolveRun, reject) => {
  const child = spawn(path, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = []; let bytes = 0, failed = false;
  const stop = () => {
   failed = true;
   if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); } }
  };
  // An unrecorded group could outlive a killed supervisor, so it is stopped at once.
  try { if (child.pid) onSpawn?.(child.pid); } catch { stop(); }
  const timer = setTimeout(stop, timeout);
  const collect = keep => chunk => {
   bytes += chunk.length;
   if (bytes > limit) stop();
   else if (keep) output.push(chunk);
  };
  child.stdout.on('data', collect(true)); child.stderr.on('data', collect(false));
  child.stdin.on('error', () => {});
  child.once('error', () => { failed = true; });
  child.once('close', code => {
   clearTimeout(timer); signal?.removeEventListener('abort', stop);
   if (failed || code !== 0) reject(Error('Business classifier failed, timed out or was canceled. Task released.'));
   else resolveRun(Buffer.concat(output).toString('utf8'));
  });
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  child.stdin.end(input);
 });
}
