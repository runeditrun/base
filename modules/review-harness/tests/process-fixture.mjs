import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const [mode, port] = process.argv.slice(2);
let origin;
if (mode === 'exit') process.exit(23);
if (mode === 'wait') {
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({ grandchild: process.pid }));
  process.send?.({ grandchild: process.pid });
  setInterval(() => {}, 1000);
} else {
  if (mode === 'tree') {
    const descendant = spawn(process.execPath, [import.meta.filename, 'wait'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    descendant.once('message', message => console.log(JSON.stringify(message)));
    process.on('SIGTERM', () => process.exit(0));
  }
  if (mode === 'term') process.on('SIGTERM', () => { console.log('received TERM'); process.exit(0); });
  const created = Date.now();
  const server = createServer((req, res) => {
    if (req.url === '/health') res.writeHead(mode === 'timeout' || (mode === 'slow' && Date.now() - created < 300) ? 503 : 200);
    else if (req.url === '/environment') res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/environment') res.end(JSON.stringify({ keys: Object.keys(process.env), env: process.env, origin }));
    else res.end('health');
  });
  server.listen(Number(port), mode === 'wide' ? '0.0.0.0' : '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    console.log(`RER_READY ${origin}`);
    if (mode === 'log') {
      process.stdout.write('synthetic-runtime-');
      setTimeout(() => process.stdout.write('credential token=synthetic-query-credential\n'), 20);
      process.stderr.write('https://local.test/?token=synthetic-last-query');
    }
  });
}
