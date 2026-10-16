import { spawn } from 'node:child_process';
import { dispatcher } from '../checkout.mjs';
import { repositoryCommands } from '../../cli/repository-contract.mjs';

// The checkout owns its capabilities; acquisition is the installed CLI's
// capability, including when that checkout pins an older dispatcher.
export async function describeCommand(target) {
 let description = {};
 if (target.root) {
  const child = spawn(process.execPath, [dispatcher(target.root).entry, ...target.args.filter(arg => arg !== '--json'), '--json'], { cwd: target.root, env: process.env, stdio: ['inherit', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code ?? 1)); });
  if (code !== 0) return code;
  description = JSON.parse(output);
 }
 process.stdout.write(JSON.stringify({ ...description, repositoryCommands }, null, target.args.includes('--json') ? undefined : 2) + '\n');
 return 0;
}
