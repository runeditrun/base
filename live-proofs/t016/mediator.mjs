#!/usr/bin/env node
import { request } from 'node:http';
import { spawn } from 'node:child_process';

// This is an execution router, not a replacement package manager. Only the
// pinned deployment script's build call crosses the broker. All other commands
// execute the image's real, independently reviewed pnpm/Wrangler installation.
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(['build'])) {
  const code = await new Promise(resolve => {
    const req = request({ socketPath: '/broker/build.sock', path: '/build', method: 'POST' }, response => {
      let text = ''; response.on('data', data => { text += data; if (text.length > 1024) response.destroy(); });
      response.on('end', () => {
        try { const value = JSON.parse(text); resolve(response.statusCode === 200 && Number.isInteger(value.exitCode) ? value.exitCode : 1); }
        catch { resolve(1); }
      });
    });
    req.on('error', () => resolve(1)); req.end();
  });
  process.exitCode = code < 0 ? 1 : code;
} else {
  const allowed = args[0] === 'exec' && args[1] === 'wrangler' && ['d1', 'r2', 'queues', 'deploy', 'whoami'].includes(args[2]);
  if (!allowed) process.exitCode = 1;
  else {
    const child = spawn('/opt/trusted/bin/pnpm', args, { stdio: 'inherit', env: process.env });
    child.on('error', () => { process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}
