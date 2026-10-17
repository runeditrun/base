// Where a user install lives. Data: ${XDG_DATA_HOME:-$HOME/.local/share}/rer,
// as immutable versions/<version>-<digest8> directories and a `current` link.
// Launcher: $HOME/.local/bin/rer, using the installer's private Node when present.
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

// The managed runtime stays inside the install root; npx installs use PATH.
export function launcherScript(data) {
 return `#!/bin/sh
${marker}
# It uses the installer's private Node when present, otherwise Node on PATH.
root=${quote(data)}
if [ -x "$root/node/bin/node" ]; then
 node="$root/node/bin/node"
 PATH="$PATH:$root/node/bin"
 export PATH
else
 node=$(command -v node) || node=
fi
if [ -z "$node" ]; then
 echo "rer: Node is missing. Run: curl -fsSL https://runeditrun.com/install.sh | sh" >&2
 exit 127
fi
exec "$node" "$root/current/global/rer.mjs" "$@"
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
