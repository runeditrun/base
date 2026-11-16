import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { localCause, redact } from './errors.mjs';
import { rememberDeviceCredential } from './run-mask.mjs';

export function credentialDirectory(env = process.env) {
 const value = env.RER_BUSINESS_CREDENTIAL_DIR;
 if (value === undefined) return null;
 if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw Error('RER_BUSINESS_CREDENTIAL_DIR must name a nonempty private directory.');
 return resolve(value);
}

export const credentialLocation = (env = process.env) => credentialDirectory(env) ?? 'OS credential storage';

/** Explicit private storage for a sealed launcher. Never consult OS storage,
 * including when the file is absent or the selected directory is refused. */
export function fileCredentialStore(directory) {
 const named = () => redact(JSON.stringify(directory));
 const refused = (reason, fix) => Error(`Business credential directory ${named()} ${reason}. ${fix}.`);
 const failed = (operation, error) => refused(`could not ${operation}: ${localCause(error) ?? 'filesystem operation failed'}`, 'Check access and free disk space, then retry');
 const owned = info => typeof process.getuid === 'function' && info.uid === process.getuid();
 async function validate() {
  let info;
  try { info = await lstat(directory); }
  catch (error) {
   if (error.code !== 'ENOENT') throw failed('be checked', error);
   try { await mkdir(directory, { recursive: true, mode: 0o700 }); info = await lstat(directory); }
   catch (error) { throw failed('be created', error); }
  }
  if (info.isSymbolicLink()) throw refused('is a symbolic link', 'Set RER_BUSINESS_CREDENTIAL_DIR to a real directory owned by your user with mode 0700');
  if (!info.isDirectory()) throw refused('is not a directory', 'Set RER_BUSINESS_CREDENTIAL_DIR to a directory owned by your user with mode 0700');
  if (!owned(info)) throw refused('is not owned by the calling user', 'Have its owner change ownership to your user, or choose a directory you own; set its mode to 0700');
  if ((info.mode & 0o7777) !== 0o700) throw refused('must have mode 0700', `Run chmod 700 on ${named()}, then retry`);
 }
 function path(handle) {
  if (typeof handle !== 'string' || !handle) throw Error('Invalid credential handle.');
  const digest = /^device:[a-f0-9]{64}$/.test(handle) ? handle.slice(7) : createHash('sha256').update(handle).digest('hex');
  return join(directory, `${digest}.credential`);
 }
 function checkFile(info) {
  if (!info.isFile() || !owned(info) || (info.mode & 0o7777) !== 0o600) throw refused('contains an unsafe credential file', 'Use a regular credential file owned by your user with mode 0600; remove symbolic links');
 }
 async function existing(file) {
  try { checkFile(await lstat(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
 }
 async function syncDirectory() {
  const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await folder.sync(); } finally { await folder.close(); }
 }
 return {
  validate,
  async check() {
   const handle = `probe:${randomUUID()}`;
   await this.set(handle, randomUUID());
   await this.delete(handle);
  },
  async get(handle) {
   await validate();
   let file;
   try {
    file = await open(path(handle), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    checkFile(await file.stat());
    const secret = await file.readFile('utf8');
    if (!secret || Buffer.byteLength(secret) > 65536 || /[\x00-\x1f\x7f]/.test(secret)) throw refused('contains an invalid credential file', 'Remove that credential file and pair this computer again');
    return rememberDeviceCredential(secret);
   } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (!error.code) throw error;
    throw failed('read the credential file', error);
   } finally { await file?.close(); }
  },
  async set(handle, secret) {
   if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 65536 || /[\x00-\x1f\x7f]/.test(secret)) throw Error('Enter a nonempty, single-line credential.');
   rememberDeviceCredential(secret);
   await validate();
   const target = path(handle), temporary = join(directory, `.credential-${randomUUID()}.tmp`);
   let file;
   try {
    await existing(target);
    file = await open(temporary, 'wx', 0o600);
    await file.chmod(0o600);
    await file.writeFile(secret, 'utf8');
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, target);
    await syncDirectory();
    return handle;
   } catch (error) { if (!error.code) throw error; throw failed('save the credential file', error); }
   finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw failed('remove a temporary file', error); });
   }
  },
  async delete(handle) {
   await validate();
   try { const target = path(handle); await existing(target); await unlink(target); await syncDirectory(); }
   catch (error) { if (error.code === 'ENOENT') return; if (!error.code) throw error; throw failed('remove the credential file', error); }
  },
 };
}
