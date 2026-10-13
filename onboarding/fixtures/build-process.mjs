import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';

// A real build subprocess stays busy until the installer cancels it.
const child = spawn(process.execPath, ['-e', "process.send(process.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const [pid] = await once(child, 'message');
// Publish the pids whole: a reader polling this path must never see the file
// truncated or half written, so it appears only by rename of a complete file.
await writeFile(process.argv[2] + '.partial', JSON.stringify([process.pid, pid]));
await rename(process.argv[2] + '.partial', process.argv[2]);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  child.kill(signal);
  child.once('close', () => process.exit(0));
});
setInterval(() => {}, 1000);
