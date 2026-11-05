import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function cli(home, args, { onOutput, onSpawn, env = {} } = {}) {
 await mkdir(home, { recursive: true });
 return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [root + 'bin/rer.mjs', 'business', ...args], { cwd: home,
   env: { PATH: process.env.PATH, HOME: home, RER_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import=${fileURLToPath(new URL('./register.mjs', import.meta.url))}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  onSpawn?.(child);
  child.stdout.on('data', bytes => { stdout += bytes; onOutput?.(stdout, child); }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', reject); child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
 });
}
export async function connect(home, remote) {
 remote.state.pollSeconds = 1; remote.state.optIns = { installPermissions: false, awakeConsent: false, installService: false };
 let approved = false;
 return cli(home, ['connect', '--code', 'ABCD-1234', '--origin', remote.origin], { onOutput: stdout => {
  if (!approved && stdout.includes('Keep this command running.')) {
   approved = true;
   void fetch(remote.origin + '/api/business/biz/pairings/pair1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, confirmation_number: '246810' }) });
  }
 } });
}
export const legacyTask = id => ({ task_id: id, kind: 'export.vendor', state: 'ready', runner: 'executor', fence: 0, title: 'Export HappyToHelp legacy history' });
