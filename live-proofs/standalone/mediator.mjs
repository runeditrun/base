import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Loaded only by immutable /route wrappers in the credential-bearing container.
// No module from the candidate dependency tree is imported here.
export async function mediate(executable) {
  const policy = JSON.parse(readFileSync('/route/policy.json', 'utf8'));
  const args = process.argv.slice(2), argv = [executable, ...args];
  const index = policy.builds.findIndex(build => JSON.stringify(build.argv) === JSON.stringify(argv) && build.cwd === process.cwd());
  if (index >= 0) {
    process.exitCode = await new Promise(resolve => {
      const req = request({ socketPath: '/broker/build.sock', path: '/build/' + index, method: 'POST' }, response => {
        let text = ''; response.on('data', data => { text += data; if (text.length > 1024) response.destroy(); });
        response.on('error', () => resolve(1));
        response.on('end', () => { try {
          const value = JSON.parse(text); resolve(response.statusCode === 200 && Number.isInteger(value.exitCode) && value.exitCode >= 0 ? value.exitCode : 1);
        } catch { resolve(1); } });
      });
      req.on('error', () => resolve(1)); req.end();
    });
  } else {
    const tool = policy.tools[executable];
    const allowed = policy.commands.some(command => command.cwd === process.cwd() && JSON.stringify(command.argv) === JSON.stringify(argv)) ||
      tool?.allow.some(prefix => prefix.every((arg, index) => args[index] === arg));
    if (!allowed) { process.exitCode = 1; return; }
    const child = spawn(tool.path, args, { stdio: 'inherit', env: process.env });
    child.on('error', () => { process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}
