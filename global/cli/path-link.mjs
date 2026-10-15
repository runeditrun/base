// Installation writes only the canonical launcher in ~/.local/bin.
// Other PATH commands are reported, never replaced or linked alongside.
import { access, constants, lstat, readlink, stat } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';
import { shellQuote } from '../../cli/node-runtime-cache.mjs';

// Older installs recorded extra PATH links; uninstall can still remove those.
export async function ownedPathLink(path, launcher) {
 try { return (await lstat(path)).isSymbolicLink() && (await readlink(path)) === resolve(launcher); }
 catch (error) { if (error.code === 'ENOENT' || error.code === 'EINVAL') return false; throw error; }
}

export async function pathAdvice(paths, env = process.env) {
 const entries = [...new Set((env.PATH ?? '').split(delimiter).map(entry => resolve(entry)))];
 const bin = resolve(paths.bin), lines = [];
 let firstCommand;
 for (const directory of entries) {
  if (directory === bin) { firstCommand ??= paths.launcher; continue; }
  const candidate = join(directory, 'rer');
  try {
   await access(candidate, constants.X_OK);
   if (!(await stat(candidate)).isFile()) continue;
   firstCommand ??= candidate;
   lines.push(`Left existing rer at ${candidate} unchanged.`);
  } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
 }
 if (!entries.includes(bin) || firstCommand !== paths.launcher) {
  const command = basename(env.SHELL ?? '') === 'fish'
   ? `set -gx PATH ${shellQuote(paths.bin)} $PATH`
   : `export PATH=${shellQuote(paths.bin)}:"$PATH"`;
  lines.push(`Add ~/.local/bin to PATH in this shell: ${command}`);
 }
 return lines.join('\n');
}
