// Offer the canonical launcher through an existing user-owned PATH directory.
// Foreign commands and links are never replaced, including during uninstall.
import { access, constants, lstat, readlink, symlink } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export async function ownedPathLink(path, launcher) {
 try { return (await lstat(path)).isSymbolicLink() && (await readlink(path)) === resolve(launcher); }
 catch (error) { if (error.code === 'ENOENT' || error.code === 'EINVAL') return false; throw error; }
}
export async function exposeLauncher(paths, env = process.env) {
 for (const entry of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
  const directory = resolve(entry), candidate = join(directory, 'rer');
  if (directory === resolve(paths.bin)) return undefined;
  try {
   try {
    await lstat(candidate);
    if (await ownedPathLink(candidate, paths.launcher)) return candidate;
    await access(candidate, constants.X_OK);
    return undefined;
   } catch (error) { if (error.code !== 'ENOENT') continue; }
   // npm/npx add transient command directories; never install into them.
   if (!isAbsolute(entry) || directory.split('/').includes('node_modules') || directory.split('/').includes('_npx')) continue;
   const info = await lstat(directory);
   if (!info.isDirectory() || !process.getuid || info.uid !== process.getuid() || (!(info.mode & 0o200) || (info.mode & 0o022))) continue;
   await access(directory, constants.W_OK | constants.X_OK);
   try { await symlink(paths.launcher, candidate); return candidate; }
   catch (error) { if (error.code !== 'EEXIST' && error.code !== 'EACCES' && error.code !== 'EPERM') throw error; }
  } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
 }
}
