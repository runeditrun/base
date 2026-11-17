// Installation writes only the canonical launcher in ~/.local/bin.
// Other PATH commands are reported, never replaced or linked alongside.
import { access, constants, lstat, readFile, readlink, stat } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';

// Older installs recorded extra PATH links; uninstall can still remove those.
export async function ownedPathLink(path, launcher) {
 try { return (await lstat(path)).isSymbolicLink() && (await readlink(path)) === resolve(launcher); }
 catch (error) { if (error.code === 'ENOENT' || error.code === 'EINVAL') return false; throw error; }
}

// Only the person executing the printed command edits their shell file.
// Match the complete PATH line before appending so repeated execution is safe.
export async function shellStartup(home, env = process.env) {
 const shell = basename(env.SHELL ?? ''), add = 'export PATH="$HOME/.local/bin:$PATH"';
 if (shell === 'fish') return { files: ['.config/fish/config.fish', '.config/fish/fish_variables'].map(file => join(home, file)), target: '~/.config/fish', line: 'fish_add_path ~/.local/bin' };
 if (!['zsh', 'bash'].includes(shell)) return { files: [], line: add };
 const file = shell === 'zsh' ? '.zshrc' : '.bashrc';
 const target = `~/${file}`;
 return { files: [join(home, file)], target, line: `(grep -Fqx '${add}' ${target} 2>/dev/null || printf '\\n%s\\n' '${add}' >> ${target}) && ${add}` };
}

// Whether a startup file already puts ~/.local/bin on PATH for new terminals.
async function persistent(files) {
 for (const file of files) {
  try { if ((await readFile(file, 'utf8')).includes('.local/bin')) return true; }
  catch (error) { if (!['ENOENT', 'EISDIR', 'EACCES'].includes(error.code)) throw error; }
 }
 return false;
}

// Empty when `rer` already runs this launcher in this terminal and new ones.
// Otherwise the advice ends with the exact line to run.
export async function pathAdvice(paths, env = process.env, { includeShellStep = true } = {}) {
 const entries = [...new Set((env.PATH ?? '').split(delimiter).filter(Boolean).map(entry => resolve(entry)))];
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
 if (!includeShellStep) return lines.join('\n');
 const startup = await shellStartup(paths.home, env);
 const first = entries.includes(bin) && firstCommand === paths.launcher;
 if (first && await persistent(startup.files)) return lines.join('\n');
 const why = first ? 'New terminals will not find rer yet.' : firstCommand ? `Another rer (${firstCommand}) comes first on your PATH.` : 'rer is not on your PATH yet.';
 const effect = basename(env.SHELL ?? '') === 'fish' ? 'fish saves ~/.local/bin in its user path configuration' : startup.target ? `you add ~/.local/bin to PATH in ${startup.target} and this terminal` : 'you add ~/.local/bin to PATH for this terminal only';
 lines.push(`Next step: ${why} Run this line; ${effect}. The installer changes no shell file:`, `  ${startup.line}`);
 if (['zsh', 'bash'].includes(basename(env.SHELL ?? ''))) lines.push('Open a new Terminal window, then `rer` works by name.');
 return lines.join('\n');
}
