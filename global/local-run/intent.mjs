import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { secureDirectory, upgradeDirectory } from './state.mjs';
import { readControl } from './journal.mjs';
import { failure } from './error.mjs';

const path = checkout => join(upgradeDirectory(checkout), 'intent.json');
export async function readIntent(checkout) {
 const intent = await readControl(path(checkout), 'upgrade intent (.rer/upgrade/intent.json)');
 if (intent && (typeof intent.wasRunning !== 'boolean' || !/^[a-f0-9]{40}$/.test(intent.head) || typeof intent.branch !== 'string')) {
  throw failure('refused', 'Unreadable upgrade intent (.rer/upgrade/intent.json); keep it and the upgrade backups and ask your agent to recover them.');
 }
 return intent;
}
export async function rememberIntent(checkout, current, wasRunning) {
 await secureDirectory(checkout, upgradeDirectory(checkout));
 let file;
 try {
  // Exclusive creation keeps concurrent handoff contenders from overwriting
  // the first attempt's running state. This precedes the custody mutation.
  file = await open(path(checkout), 'wx', 0o600);
  await file.writeFile(JSON.stringify({ ...current, wasRunning }) + '\n');
  await file.sync();
 } catch (error) { if (error.code !== 'EEXIST') throw error; }
 finally { await file?.close(); }
 const parent = await open(upgradeDirectory(checkout), 'r');
 try { await parent.sync(); } finally { await parent.close(); }
 const intent = await readIntent(checkout);
 if (intent.head !== current.head || intent.branch !== current.branch) throw failure('refused', 'An unfinished upgrade intent remains in .rer/upgrade/intent.json; keep it and recover the original checkout before upgrading.');
 return intent.wasRunning;
}
export const forgetIntent = checkout => rm(path(checkout), { force: true });
