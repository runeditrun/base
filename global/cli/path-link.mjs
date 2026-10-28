// Installation writes only the canonical launcher in ~/.local/bin.
// Other PATH commands are reported, never replaced or linked alongside.
import { access, constants, lstat, readFile, readlink, stat } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';

// Older installs recorded extra PATH links; uninstall can still remove those.
export async function ownedPathLink(path, launcher) {
 try { return (await lstat(path)).isSymbolicLink() && (await readlink(path)) === resolve(launcher); }
 catch (error) { if (error.code === 'ENOENT' || error.code === 'EINVAL') return false; throw error; }
}

const exists = path => access(path).then(() => true, () => false);

// The files a new terminal of this shell reads, and the one line that puts
// ~/.local/bin on PATH in this terminal and, through the startup file, in new
// ones. rer never runs it: the person does.
export async function shellStartup(home, env = process.env, platform = process.platform) {
 const shell = basename(env.SHELL ?? ''), add = 'export PATH="$HOME/.local/bin:$PATH"';
 if (shell === 'fish') return { files: ['.config/fish/config.fish', '.config/fish/fish_variables'].map(file => join(home, file)), line: 'fish_add_path ~/.local/bin' };
 if (shell === 'zsh') {
  const directory = env.ZDOTDIR || home;
  return { files: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map(file => join(directory, file)), line: `echo '${add}' >> ${env.ZDOTDIR ? '"$ZDOTDIR/.zshrc"' : '~/.zshrc'} && ${add}` };
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
 return { files: files.map(name => join(home, name)), line: `echo '${add}' >> ~/${file} && ${add}` };
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
 lines.push(`Optional: make rer available in future terminals. ${why} Running the following line adds ~/.local/bin to your shell's startup file and this terminal. rer changes no shell file itself:`, `  ${startup.line}`);
 return lines.join('\n');
}
