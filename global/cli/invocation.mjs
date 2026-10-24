// How the person runs this rer again from their own shell: the first words of
// every next-step line rer prints. install.sh names the launcher it ran
// (RER_INVOKED_AS). Otherwise `rer` when the first rer on PATH runs the
// launcher rer cli install wrote; that launcher's own path when it is not on
// PATH yet (an npx start writes it too); `rer` for another rer on PATH; and
// npx when there is no rer at all.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';
import { launcherWritten, layout } from './layout.mjs';

const word = value => /^[A-Za-z0-9_./~:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
const real = path => { try { return realpathSync(path); } catch { return undefined; } };

function firstOnPath(path = '') {
 // npm exec puts node_modules/.bin directories on PATH only for its own run.
 for (const directory of path.split(delimiter).filter(entry => entry && !entry.endsWith(join('node_modules', '.bin')))) {
  const candidate = join(directory, 'rer');
  try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; }
  catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
 }
}

export function rerWord(env = process.env) {
 if (env.RER_INVOKED_AS) return env.RER_INVOKED_AS === 'rer' ? 'rer' : shown(env.RER_INVOKED_AS, layout(env).home);
 const { home, launcher } = layout(env), first = firstOnPath(env.PATH);
 if (!launcherWritten(launcher)) return first ? 'rer' : 'npx -y @runeditrun/rer';
 return first && real(first) === real(launcher) ? 'rer' : shown(launcher, home);
}

// A path under HOME as ~/..., which every shell expands at the start of a word.
const shown = (path, home) => path.startsWith(home + sep) ? `~/${word(relative(home, path))}` : word(path);

// The --cwd a next-step command needs when the person's shell is not in the
// checkout: relative when the checkout is below that folder, else absolute.
export function cwdArgument(checkout, shellDirectory) {
 if (!shellDirectory || shellDirectory === checkout) return '';
 return ` --cwd ${word(checkout.startsWith(shellDirectory + sep) ? relative(shellDirectory, checkout) : checkout)}`;
}
