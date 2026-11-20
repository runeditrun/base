import { execFile } from 'node:child_process';

export function inspectionCommand(command, args, { timeout, maxBuffer, signal, keepPartialOutput }) {
 signal?.throwIfAborted();
 return new Promise((resolve, reject) => {
  let timer, stdout = '';
  const finish = (error, output, stderr) => {
   clearTimeout(timer);
   signal?.removeEventListener('abort', abort);
   if (error) reject(Object.assign(error, { stdout: output, stderr }));
   else resolve(output);
  };
  const child = execFile(command, args, { maxBuffer, killSignal: 'SIGKILL' }, finish);
  const abandon = error => {
   // Even SIGKILL can leave a process in a kernel wait. Release rer's
   // handles and settle here, independently of the child and its callback.
   finish(error, stdout, '');
   try { child.kill('SIGKILL'); } catch { /* the deadline still applies */ }
   child.stdin?.destroy();
   child.stdout?.destroy();
   child.stderr?.destroy();
   child.unref();
  };
  const abort = () => abandon(new Error('Inspection cancelled'));
  // Only a positive observation of state-file custody can use partial output.
  if (keepPartialOutput) child?.stdout?.on('data', data => { stdout = (stdout + data).slice(0, maxBuffer); });
  timer = setTimeout(() => abandon(Object.assign(new Error('Inspection timed out'), { killed: true })), timeout);
  signal?.addEventListener('abort', abort, { once: true });
 });
}
