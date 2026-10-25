import { constants } from 'node:fs';
import { open, rename, link, lstat, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { shared } from '../shared.mjs';
import { pause } from './api.mjs';

const missing = error => { if (error.code !== 'ENOENT') throw error; };
// A rename keeps these fields, so a lock moved aside is still recognised.
const key = status => `${status.dev}:${status.ino}:${status.mtimeNs}`;

// One rer business sync at a time in a checkout: two at once would each
// rewrite .dev.vars and post into the Worker restart the other one started.
// The lock names its owner's PID and start time; once that process is gone,
// the next sync takes the lock over. Returns the release, for a finally.
export async function syncLock(root, signal) {
 const [{ privateDirectory }, { ownerAlive }, { processStart }] = await Promise.all(['private-files.mjs', 'local/operation.mjs', 'local/process-table.mjs'].map(file => shared(file)));
 const created = await lstat(join(root, '.rer')).then(() => false, error => { missing(error); return true; });
 const path = join(await privateDirectory(root, ['.rer']), 'business-sync.lock');
 const owner = JSON.stringify({ pid: process.pid, start: await processStart(process.pid) });
 for (;;) {
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
   // Another refused sync removed the .rer folder it had made.
   if (error.code === 'ENOENT') { await privateDirectory(root, ['.rer']); continue; }
   if (error.code !== 'EEXIST') throw error;
   const judged = await stale(path, ownerAlive);
   if (judged) await takeOver(path, judged);
   else if (judged === undefined) await pause(200, signal);
   continue;
  }
  try { await file.writeFile(owner); } finally { await file.close(); }
  const held = key(await lstat(path, { bigint: true }));
  return async () => {
   if (await lstat(path, { bigint: true }).then(key, () => null) === held) await unlink(path).catch(missing);
   // A refused sync leaves no .rer folder it made itself.
   if (created) await rmdir(dirname(path)).catch(() => {});
  };
 }
}

// The identity of a lock whose owner is gone, null when no lock is there, or
// undefined while its owner runs. A lock not yet written is judged by its age.
async function stale(path, ownerAlive) {
 let handle;
 try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
 try {
  const status = await handle.stat({ bigint: true });
  if (!status.isFile()) throw Error('The Business sync lock .rer/business-sync.lock is not a file. Remove it, then run rer business sync again.');
  let owner;
  try { owner = JSON.parse(await handle.readFile('utf8')); } catch { /* Not written yet. */ }
  const gone = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? !await ownerAlive(owner) : Date.now() - Number(status.mtimeMs) > 10_000;
  return gone ? key(status) : undefined;
 } finally { await handle.close(); }
}

// Move the lock aside, then check it is the one judged stale: a lock another
// sync made meanwhile is put back.
async function takeOver(path, judged) {
 const aside = `${path}.${randomUUID()}`;
 try { await rename(path, aside); } catch (error) { missing(error); return; }
 if (key(await lstat(aside, { bigint: true })) !== judged) await link(aside, path).catch(error => { if (error.code !== 'EEXIST') throw error; });
 await unlink(aside);
}
