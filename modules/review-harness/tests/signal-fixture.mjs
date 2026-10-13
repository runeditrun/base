import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';

if (process.argv[2] === 'descendant') {
  process.on('SIGTERM', () => {});
  process.send({ ready: true });
  setInterval(() => {}, 1000);
} else {
  const [port, receipt, phase] = process.argv.slice(2);
  const descendant = spawn(process.execPath, [import.meta.filename, 'descendant'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise(resolve => descendant.once('message', resolve));
  process.on('SIGTERM', () => process.exit(0));
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(phase === 'startup' ? 503 : 200); res.end('health'); }
    else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html lang="en"><head><title>Signal review</title></head><body><main><h1>Signal review</h1><a href="/">Home</a></main></body></html>');
    }
  });
  await new Promise(resolve => server.listen(Number(port), '127.0.0.1', resolve));
  await writeFile(receipt + '.tmp', JSON.stringify({ runtime: process.pid, grandchild: descendant.pid, port: Number(port) }));
  await rename(receipt + '.tmp', receipt);
}
