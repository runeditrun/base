// Read-only view of the shared server registry that every pinned dispatcher
// writes (RER_SERVERS_DIR, else the account's ~/.rer/servers).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { alive } from '../modules/job-queue/identity.mjs';
import { rerWord } from './cli/invocation.mjs';

export const serversDirectory = (env = process.env) => resolve(env.RER_SERVERS_DIR ?? join((env.HOME || homedir()), '.rer/servers'));

export async function liveServers(env = process.env) {
 let state;
 try { state = JSON.parse(await readFile(join(serversDirectory(env), 'state.json'), 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return []; throw error; }
 const live = [];
 for (const record of state.running ?? []) {
  // An identity that cannot be verified is kept, as the dispatchers keep it,
  // and so is one the process table does not answer for within a few seconds.
  let running = true;
  try { running = await alive(record.owner, { bound: 3000 }); } catch {}
  if (running) live.push(record);
 }
 return live;
}

export const stopCommand = record => `${rerWord()} ${record.mode} --stop --cwd ${JSON.stringify(record.checkout)}`;
