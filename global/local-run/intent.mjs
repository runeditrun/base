import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { upgradeDirectory, writeJSON } from './state.mjs';
import { readControl } from './journal.mjs';
import { text } from './process.mjs';
import { failure } from './error.mjs';

const path = checkout => join(upgradeDirectory(checkout), 'intent.json');
export async function readIntent(checkout) {
 const intent = await readControl(path(checkout), 'upgrade intent (.rer/upgrade/intent.json)');
 if (intent) {
  try {
   if (typeof intent.wasRunning !== 'boolean' || !/^[a-f0-9]{40}$/.test(intent.head) || typeof intent.branch !== 'string' ||
    intent.custody !== undefined && !/^[a-f0-9]{64}$/.test(intent.custody)) throw Error();
   // A moved real HEAD is ordinary history, not corrupt input. An invented
   // object identity is not a valid interrupted attempt and stays untouched.
   await text(checkout, ['cat-file', '-e', `${intent.head}^{commit}`]);
  } catch { throw failure('refused', 'Unreadable upgrade intent (.rer/upgrade/intent.json); keep it and the upgrade backups and ask your agent to recover them.'); }
 }
 return intent;
}

// A current app is authoritative. In its absence, carry running intent only
// while reclaiming the exact crashed custody: owner start/stop supersedes it.
export function intendedRunning(record, custody, running) {
 return Boolean(running) || Boolean(record?.wasRunning && record.runtimeSettled !== true &&
  custody.reclaimedIdentity && (record.custody ? record.custody === custody.reclaimedIdentity : true));
}
export async function rememberIntent(checkout, current, wasRunning, custody) {
 // With a running server, contenders share the same custody witness before
 // handoff; otherwise the caller already holds the exclusive operation lock.
 // Atomic replacement supersedes a stale intent regardless of today's HEAD.
 await writeJSON(checkout, path(checkout), { ...current, wasRunning, custody: custody.identity });
}
export const forgetIntent = checkout => rm(path(checkout), { force: true });
