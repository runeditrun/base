import { spawn } from 'node:child_process';
import { join } from 'node:path';

export function launchInstaller(directory, args) {
  return new Promise((resolve, reject) => {
    // Inherited stdin passes secrets directly to the edition; the launcher never reads them.
    const child = spawn(process.execPath, [join(directory, 'scripts', 'install.mjs'), ...args], { cwd: directory, stdio: 'inherit', shell: false });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', () => { cleanup(); reject(Error('Could not start the seed installer. Your checkout is retained; use --resume.')); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}
