import { spawn } from 'node:child_process';

// A passing run that starts a helper in its own session (as Chromium does) and
// leaves it behind: the helper outlives the run unless cleanup stops it.
const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
stray.unref();
process.stdout.write(`${stray.pid}\n`);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
