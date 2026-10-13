// The update notice: in human output on a terminal, at most once per 24 hours,
// one line naming a newer published version. Never in --json output or when
// stdout is not a terminal, never more than about 1.5 s of delay (even when the
// registry accepts the connection and never answers), and off with
// RER_NO_UPDATE_CHECK=1. The check time lives in ${XDG_CACHE_HOME:-~/.cache}/rer.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout } from '../cli/layout.mjs';
import { channelOf } from '../cli/status.mjs';
import { ownManifest } from '../package-info.mjs';
import { compareVersions } from './registry.mjs';

const interval = 24 * 60 * 60 * 1000, budget = 1500;

export const wantsNotice = (argv, env = process.env) => env.RER_NO_UPDATE_CHECK !== '1' && Boolean(process.stdout.isTTY) && !argv.includes('--json');

export async function updateNotice(env = process.env) {
 const file = join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'rer', 'update-check.json');
 try {
  if ((await channelOf(layout(env))).channel === 'source') return;
  let checkedAt = 0;
  try { checkedAt = JSON.parse(await readFile(file, 'utf8')).checkedAt ?? 0; } catch {}
  if (Date.now() - checkedAt < interval) return;
  // Record the attempt first: a slow or failed registry costs one wait a day.
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({ checkedAt: Date.now() }) + '\n');
  const latest = await latestVersion(env);
  const current = ownManifest().version;
  if (latest && compareVersions(latest, current) > 0) process.stderr.write(`rer ${latest} is available (this is ${current}). Update with: rer update\n`);
 } catch {
  // The notice never stands in the way of the command.
 }
}

// The registry is asked by a child process that is killed at the budget. An
// in-process request can be aborted, but its pending TCP connect (or DNS
// lookup) still holds this process open until the system gives up: about 10 s
// when the registry drops packets.
function latestVersion(env) {
 return new Promise(resolve => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./latest.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  const finish = () => {
   clearTimeout(timer);
   child.kill('SIGKILL');
   child.unref();
   child.stdout.destroy();
   resolve(/^\S+(?=\n)/.exec(output)?.[0]);
  };
  const timer = setTimeout(finish, budget);
  child.stdout.setEncoding('utf8').on('data', data => { output += data; if (output.includes('\n')) finish(); });
  child.once('error', finish);
  child.once('close', finish);
 });
}
