// Where a user install lives. Data: ${XDG_DATA_HOME:-$HOME/.local/share}/rer,
// as immutable versions/<version>-<digest8> directories and a `current` link.
// Launcher: $HOME/.local/bin/rer, a POSIX sh script that runs node from PATH.
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function layout(env = process.env) {
 const home = env.HOME || homedir();
 const data = join(env.XDG_DATA_HOME || join(home, '.local/share'), 'rer');
 const bin = join(home, '.local/bin');
 return { home, data, versions: join(data, 'versions'), current: join(data, 'current'), record: join(data, 'install.json'), bin, launcher: join(bin, 'rer') };
}

const marker = '# rer launcher, written by `rer cli install` (@runeditrun/rer). Do not edit.';
const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;

// No absolute Node path is baked in, so a Node upgrade never breaks it.
export function launcherScript(data) {
 return `#!/bin/sh
${marker}
# It runs the installed version with the node on PATH.
root=${quote(data)}
if ! command -v node >/dev/null 2>&1; then
 echo "rer: node is not on PATH. Install Node 22 or later, then run rer again." >&2
 exit 127
fi
exec node "$root/current/global/rer.mjs" "$@"
`;
}

// 'absent', 'ours' (with the install root it runs), or 'foreign'.
export async function launcherOwner(path) {
 let info;
 try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
 if (!info.isFile()) return { state: 'foreign' };
 const text = await readFile(path, 'utf8');
 if (text.split('\n')[1] !== marker) return { state: 'foreign' };
 const root = /^root='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]?.replaceAll(`'\\''`, "'");
 return { state: 'ours', root, text };
}

export async function installRecord(paths) {
 try { return JSON.parse(await readFile(paths.record, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
