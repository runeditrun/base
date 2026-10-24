import { spawn } from 'node:child_process';

// Capture checkout output locally. It can contain private settings and sign-in
// links, so callers publish only closed phase/result objects, never these bytes.
export function run(command, args, { cwd, env = {}, input, allow = [], timeout = 600000, maxBuffer = 16 * 1024 * 1024, onLine } = {}) {
 return new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', pending = '', overflow = false;
  let escalation;
  const stop = signal => { child.kill(signal); escalation ??= setTimeout(() => child.kill('SIGKILL'), 3000); };
  const timer = setTimeout(() => stop('SIGTERM'), timeout);
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => stop(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.stdout.on('data', bytes => {
   stdout += bytes; pending += bytes;
   if (stdout.length > maxBuffer) { overflow = true; stop('SIGTERM'); }
   let end;
   while ((end = pending.indexOf('\n')) >= 0) { onLine?.(pending.slice(0, end)); pending = pending.slice(end + 1); }
  });
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > maxBuffer) { overflow = true; stop('SIGTERM'); } });
  child.once('error', finish);
  child.once('close', (code, signal) => {
   if (pending) onLine?.(pending);
   const result = { stdout, stderr, code: code ?? 1 };
   finish(overflow || result.code && !allow.includes(result.code) ? Object.assign(new Error('Local command failed'), { ...result, signal }) : null, result);
  });
  function finish(error, value) {
   clearTimeout(timer);
   clearTimeout(escalation);
   for (const [signal, handler] of handlers) process.off(signal, handler);
   if (error) reject(error); else resolve(value);
  }
  child.stdin.on('error', () => {});
  child.stdin.end(input);
 });
}

export const git = (checkout, args, options = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: checkout, ...options });
export const text = async (checkout, args, options) => (await git(checkout, args, options)).stdout.trim();
