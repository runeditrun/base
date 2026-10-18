import { accessSync, statSync, constants } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const npx = 'npx -y @runeditrun/rer';
const word = value => /^[A-Za-z0-9_./~:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

function onPath(path = '') {
 // npm exec puts node_modules/.bin directories on PATH only for its own run.
 for (const directory of path.split(delimiter).filter(entry => entry && !entry.endsWith(join('node_modules', '.bin')))) {
  const candidate = join(directory, 'rer');
  try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return true; }
  catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
 }
 return false;
}

// How the person runs this rer again from their own shell in a later turn.
// An npx run leaves nothing installed; install.sh says which launcher it ran
// (RER_INVOKED_AS), since it adds that launcher to PATH only for itself.
export function rerCommand(env = process.env) {
 if (fileURLToPath(import.meta.url).split(sep).includes('_npx')) return npx;
 if (env.RER_INVOKED_AS) return word(env.RER_INVOKED_AS);
 return onPath(env.PATH) ? 'rer' : npx;
}
