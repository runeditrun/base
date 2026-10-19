import { mkdir, readFile, readdir, writeFile, rename, chmod, open, unlink, rm, rmdir, lstat, utimes } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { localCause } from './errors.mjs';

// RER_BUSINESS_STATE_DIR names the folder itself, for agent sandboxes that may write only
// inside their working folder. Without it the state lives in ~/.rer/business.
// RER_STATE_DIR belongs to rer demo and is never read here.
export const chosenStateDirectory = () => Boolean(process.env.RER_BUSINESS_STATE_DIR);
export function stateDirectory() {
 const chosen = process.env.RER_BUSINESS_STATE_DIR;
 if (!chosen) return join(homedir(), '.rer', 'business');
 if (chosen.includes('\0')) throw Error('RER_BUSINESS_STATE_DIR must name a folder.');
 return resolve(chosen);
}
export const credentialHandle = origin => `device:${createHash('sha256').update(origin).digest('hex')}`;

async function loadJson(name) {
 const path = join(stateDirectory(), name);
 let text;
 try { text = await readFile(path, 'utf8'); }
 // Under a path that is not a folder (ENOTDIR) nothing can have been saved yet.
 catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
 try { return JSON.parse(text); }
 catch { throw Error(`Business could not read ${path}: it is not valid JSON. Remove it, or run rer business disconnect, then connect again.`); }
}

export const loadState = () => loadJson('state.json');
export const loadPending = () => loadJson('pairing.json');
export const savePending = pending => saveJson('pairing.json', pending);
export async function clearPending() {
 await unlink(join(stateDirectory(), 'pairing.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

// Only non-secret configuration and progress belong here. Credentials and task
// grants remain in the keychain and memory, respectively.
export async function saveState(state) {
 return saveJson('state.json', state);
}

// A short-lived pairing poll token must survive agent turns. It is not a
// device credential; keep it private, expiring, and separate from paired state.
async function saveJson(name, value) {
 const directory = stateDirectory();
 await mkdir(directory, { recursive: true, mode: 0o700 });
 await chmod(directory, 0o700);
 const temporary = join(directory, `${randomUUID()}.tmp`);
 try {
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, name));
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Before a one-use code is spent or an approval collected, prove the state
 * folder takes the same private create, write and replace the pairing needs.
 * Folders made only for the check are removed again, so a refused connect
 * leaves nothing behind.
 */
export async function checkStateWritable() {
 const directory = stateDirectory(), probe = join(directory, `${randomUUID()}.tmp`), created = [];
 for (let path = directory; path !== dirname(path); path = dirname(path)) {
  try { await lstat(path); break; } catch (error) { if (error.code !== 'ENOENT') break; created.push(path); }
 }
 try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(probe, '{}\n', { mode: 0o600, flag: 'wx' });
  await rename(probe, probe + '.check');
  await unlink(probe + '.check');
 } catch (error) {
  await unlink(probe).catch(() => {});
  const fix = chosenStateDirectory()
   ? 'Allow writes to that folder in this session, or set RER_BUSINESS_STATE_DIR to a folder this session can write'
   : 'Allow writes to that folder, or set RER_BUSINESS_STATE_DIR to a folder this session can write (in Codex, one inside the working folder, such as RER_BUSINESS_STATE_DIR="$PWD/.rer-business")';
  throw Error(`Business cannot save its state in ${directory}: ${localCause(error) ?? error.message}. Nothing was sent, so the pairing code still works. ${fix}, then run connect again.`);
 } finally {
  for (const path of created) await rmdir(path).catch(() => {});
 }
}

// Files this CLI writes in its state folder. A folder named by RER_BUSINESS_STATE_DIR
// may hold other things, so only these are removed from it.
const owned = /^(?:(?:state|pairing|progress|permissions|service)\.json|run\.lock|disconnect|service(?:-error)?\.log|discovery-[A-Za-z0-9_.:-]+\.(?:json|tmp)|export-[0-9a-f]{32}\.bundle|.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp(?:\.check)?)$/;
/** After a revocation whose local cleanup was refused, keep only what a later
 * disconnect needs to finish: the state and the receipts of what remains. */
export async function removeWorkFiles(keep = ['state.json', 'permissions.json', 'service.json']) {
 let entries;
 try { entries = await readdir(stateDirectory()); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
 for (const name of entries) if (owned.test(name) && !keep.includes(name)) await rm(join(stateDirectory(), name), { force: true });
}

export async function removeStateDirectory() {
 const directory = stateDirectory();
 if (!chosenStateDirectory()) {
  await rm(directory, { recursive: true, force: true });
  // Remove only an empty parent; other rer commands may own it.
  await rmdir(dirname(directory)).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  return;
 }
 let entries;
 try { entries = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
 for (const name of entries) if (owned.test(name)) await rm(join(directory, name), { force: true });
 await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
}

// run.lock holds the supervisor's process id, and its time is refreshed while
// it runs. A lock whose process is gone, or that has not been refreshed for
// two minutes (a process id a sandbox cannot check), is stale and replaced.
const lockFresh = 120_000;
export const lockPath = () => join(stateDirectory(), 'run.lock');
export async function liveSupervisor(path = lockPath()) {
 let text, info;
 try { [text, info] = await Promise.all([readFile(path, 'utf8'), lstat(path)]); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
 // A lock is written right after it is created; give an empty one a moment.
 if (!text) return Date.now() - info.mtimeMs < 5_000 ? 'starting' : null;
 const pid = Number(text);
 if (!Number.isSafeInteger(pid) || pid <= 0) return null;
 try { process.kill(pid, 0); }
 catch (error) { if (error.code === 'ESRCH') return null; if (error.code !== 'EPERM') throw error; }
 return Date.now() - info.mtimeMs > lockFresh ? null : pid;
}

/** Take run.lock, replacing a stale one. The returned release removes it; it is
 * also removed on every exit of this process, including after a signal. */
export async function lockSupervisor() {
 const directory = stateDirectory(), path = lockPath();
 await mkdir(directory, { recursive: true, mode: 0o700 });
 for (let attempt = 0; attempt < 2; attempt++) {
  try {
   const file = await open(path, 'wx', 0o600);
   await file.writeFile(String(process.pid)); await file.close();
   const refresh = setInterval(() => { const now = new Date(); utimes(path, now, now).catch(() => {}); }, 30_000);
   refresh.unref();
   const exit = () => { try { if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); } catch { /* Already gone. */ } };
   process.once('exit', exit);
   const release = async () => { clearInterval(refresh); process.off('exit', exit); exit(); };
   // A signal is often followed closely by SIGKILL (an agent closing its
   // terminal), so a signal handler removes the lock synchronously at once.
   release.now = exit;
   return release;
  } catch (error) {
   if (error.code !== 'EEXIST') throw error;
   const pid = await liveSupervisor(path);
   if (pid) throw Error(`A Business supervisor is already running for this computer${pid === 'starting' ? '' : ` (process ${pid})`}. Let it keep working, or stop it before starting another.`);
   await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
 }
 throw Error('Could not acquire Business supervisor lock.');
}
