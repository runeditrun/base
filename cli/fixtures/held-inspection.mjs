import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Use a real child and its pipes. Model a kernel wait at the signal edge:
// record the SIGKILL request while the inspection stays alive until teardown.
const exec = cp.execFile, journal = process.env.RER_TEST_HELD_INSPECTION;
cp.execFile = (command, args, options, callback) => {
 const inspection = process.platform === 'linux'
  ? command === '/bin/ps' && args.includes('pid=,ppid=')
  : command.endsWith('/lsof') && args.includes('-iTCP');
 if (!inspection) return exec(command, args, options, callback);
 const child = exec(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], options, callback);
 appendFileSync(journal, `${child.pid} started ${Date.now()}\n`);
 const kill = child.kill.bind(child);
 child.kill = signal => {
  if (signal !== 'SIGKILL') return kill(signal);
  appendFileSync(journal, `${child.pid} ${signal}\n`);
  return true;
 };
 return child;
};
cp.execFile[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
 cp.execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
syncBuiltinESMExports();
