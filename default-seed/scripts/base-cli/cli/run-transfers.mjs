// Archive payloads measured by install.sh; Git and package managers do not
// expose wire-byte totals here. Disk blocks are measured separately, never
// substituted for download sizes. No checkout content or credentials are read.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { coldRunBudget } from '../foundation/runtime/run-data.mjs';
const ownRoot = fileURLToPath(new URL('../', import.meta.url));

const execute = promisify(execFile);
export function showBudget(args) {
 if (!args.includes('--json') && !process.env.RER_BUDGET_SHOWN) process.stderr.write(coldRunBudget + '\n');
 process.env.RER_BUDGET_SHOWN = '1';
}
const payload = value => /^\d+$/.test(value ?? '') ? `${value} bytes` : 'not measured';
async function disk(path) {
 try {
  const { stdout } = await execute('du', ['-sk', path], { timeout: 10000 });
  const blocks = Number(stdout.match(/^\d+/)?.[0]);
  if (Number.isSafeInteger(blocks)) return `${blocks * 1024} bytes`;
 } catch { /* An unavailable measurement is stated, never estimated. */ }
 return 'not measured';
}
export async function launchSummary(root) {
 const components = [['rer', ownRoot], ['clone (Git objects)', root && join(root, '.git')], ['dependencies', root && join(root, 'node_modules')]];
 const sizes = await Promise.all(components.map(async ([name, path]) => `${name}: ${path ? await disk(path) : 'not measured'}`));
 const lines = [
  `Downloads this run (archive payloads): Node installer: ${payload(process.env.RER_TRANSFER_NODE_BYTES)}; rer installer: ${payload(process.env.RER_TRANSFER_RER_BYTES)}.`,
  'Other downloads: project Node, clone and dependencies: not measured. Package-manager caches and metadata are not included in archive counts.',
  `Disk use now (allocated space, not download sizes): ${sizes.join('; ')}.`,
 ];
 if (process.env.RER_TRANSFER_NODE_DISK) lines.push(`Installer Node disk use: ${payload(process.env.RER_TRANSFER_NODE_DISK)}.`);
 if (process.env.RER_LAUNCH_PATH_STEP) lines.push(process.env.RER_LAUNCH_PATH_STEP);

 return lines;
}
