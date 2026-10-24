// A legacy dispatcher's Node re-exec inherits these pipes. Its output must
// return through the ready filter, rather than inherit the caller's raw fd.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export async function pipedHandoff(entry, args, root, output) {
 const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
 for (const [signal, handler] of handlers) process.on(signal, handler);
 child.stdout.on('data', output.stdout); child.stderr.on('data', output.stderr);
 try {
  const code = await new Promise((resolve, reject) => {
   child.once('error', reject);
   child.once('close', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
  await output.close();
  process.exitCode = code;
  return code;
 } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}
