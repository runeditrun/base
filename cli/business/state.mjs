import { mkdir, readFile, writeFile, rename, chmod, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const stateDirectory = () => join(homedir(), '.rer', 'business');
export const credentialHandle = origin => `device:${createHash('sha256').update(origin).digest('hex')}`;

export async function loadState() {
 try { return JSON.parse(await readFile(join(stateDirectory(), 'state.json'), 'utf8')); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Only non-secret configuration and progress belong here. Credentials and task
// grants remain in the keychain and memory, respectively.
export async function saveState(state) {
 const directory = stateDirectory();
 await mkdir(directory, { recursive: true, mode: 0o700 });
 await chmod(directory, 0o700);
 const temporary = join(directory, `${randomUUID()}.tmp`);
 try {
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, 'state.json'));
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function lockSupervisor() {
 const directory = stateDirectory();
 await mkdir(directory, { recursive: true, mode: 0o700 });
 const path = join(directory, 'run.lock');
 for (let attempt = 0; attempt < 2; attempt++) {
  try {
   const file = await open(path, 'wx', 0o600);
   await file.writeFile(String(process.pid)); await file.close();
   return async () => { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); };
  } catch (error) {
   if (error.code !== 'EEXIST') throw error;
   const pid = Number(await readFile(path, 'utf8'));
   if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Business supervisor lock is invalid.');
   try { process.kill(pid, 0); throw Error('A Business supervisor is already running.'); }
   catch (check) { if (check.code !== 'ESRCH') throw check; }
   await unlink(path);
  }
 }
 throw Error('Could not acquire Business supervisor lock.');
}
