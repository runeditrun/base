// Installation writes only the canonical launcher in its bin folder.
// Other PATH commands are reported, never replaced or linked alongside.
import { access, constants, lstat, readFile, readlink, stat } from 'node:fs/promises';
import { basename, delimiter, join, relative, resolve, sep } from 'node:path';

// Older installs recorded extra PATH links; uninstall can still remove those.
export async function ownedPathLink(path, launcher) {
 try { return (await lstat(path)).isSymbolicLink() && (await readlink(path)) === resolve(launcher); }
 catch (error) { if (error.code === 'ENOENT' || error.code === 'EINVAL') return false; throw error; }
}

const exists = path => access(path).then(() => true, () => false);

// The bin folder as a startup file writes it: under HOME through $HOME, so the
// line stays right if HOME moves; elsewhere the folder itself.
const shellPath = (home, bin) => bin.startsWith(home + sep) ? `$HOME/${relative(home, bin)}` : bin;

// The files a new terminal of this shell reads, and the one line that puts the
// bin folder (~/.local/bin unless the install was redirected) on PATH in this
// terminal and, through the startup file, in new ones. rer never runs it: the person does.
export async function shellStartup(home, env = process.env, platform = process.platform, bin = join(home, '.local/bin')) {
 const shell = basename(env.SHELL ?? ''), folder = shellPath(home, bin), add = `export PATH="${folder}:$PATH"`;
 if (shell === 'fish') return { files: ['.config/fish/config.fish', '.config/fish/fish_variables'].map(file => join(home, file)), line: `fish_add_path ${folder === `$HOME/.local/bin` ? '~/.local/bin' : JSON.stringify(folder)}`, folder };
 if (shell === 'zsh') {
  const directory = env.ZDOTDIR || home;
  return { files: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map(file => join(directory, file)), line: `echo '${add}' >> ${env.ZDOTDIR ? '"$ZDOTDIR/.zshrc"' : '~/.zshrc'} && ${add}`, folder };
 }
 const files = shell === 'bash' ? ['.bash_profile', '.bash_login', '.profile', '.bashrc'] : ['.profile'];
 // macOS terminals start bash as a login shell, which reads only the first of
 // its profiles that exists; elsewhere a terminal's bash reads ~/.bashrc.
 let file = '.profile';
 if (shell === 'bash' && platform !== 'darwin') file = '.bashrc';
 else if (shell === 'bash') {
  file = '.bash_profile';
  for (const candidate of files.slice(0, 3)) if (await exists(join(home, candidate))) { file = candidate; break; }
 }
 return { files: files.map(name => join(home, name)), line: `echo '${add}' >> ~/${file} && ${add}`, folder };
}

// Whether a startup file already puts the bin folder on PATH for new terminals.
async function persistent(files, folders) {
 for (const file of files) {
  try { const text = await readFile(file, 'utf8'); if (folders.some(folder => text.includes(folder))) return true; }
  catch (error) { if (!['ENOENT', 'EISDIR', 'EACCES'].includes(error.code)) throw error; }
 }
 return false;
}

// Empty when `rer` already runs this launcher in this terminal and new ones.
// Otherwise the advice ends with the exact line to run.
export async function pathAdvice(paths, env = process.env) {
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
 const startup = await shellStartup(paths.home, env, process.platform, bin);
 const first = entries.includes(bin) && firstCommand === paths.launcher;
 const shown = startup.folder.replace(/^\$HOME\//, '~/');
 if (first && await persistent(startup.files, [...new Set([startup.folder.replace(/^\$HOME\//, ''), shown.replace(/^~\//, ''), bin])])) return lines.join('\n');
 const why = first ? 'New terminals will not find rer yet.' : firstCommand ? `Another rer (${firstCommand}) comes first on your PATH.` : 'rer is not on your PATH yet.';
 lines.push(`${why} Run this line; it puts ${shown} first on PATH in this terminal and in new ones:`, `  ${startup.line}`);
 return lines.join('\n');
}
