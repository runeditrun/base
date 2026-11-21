// Where a user install lives. Data: ${XDG_DATA_HOME:-$HOME/.local/share}/rer,
// as immutable versions/<version>-<digest8> directories and a `current` link.
// The launcher uses the bin directory alongside the data home, or XDG_BIN_HOME
// when both XDG homes are set.
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { shellQuote } from '../../cli/node-runtime-cache.mjs';

export function layout(env = process.env) {
 const home = env.HOME || homedir();
 const dataHome = env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(home, '.local/share');
 const data = join(dataHome, 'rer'), defaultBin = join(home, '.local/bin');
 const bin = env.XDG_DATA_HOME ? resolve(env.XDG_BIN_HOME || join(dirname(dataHome), 'bin')) : defaultBin;
 return { home, data, versions: join(data, 'versions'), current: join(data, 'current'), record: join(data, 'install.json'), bin, defaultBin, launcher: join(bin, 'rer') };
}

const marker = '# rer launcher, written by `rer cli install` (@runeditrun/rer). Do not edit.';

export const launcherCommand = paths => paths.bin === paths.defaultBin ? '~/.local/bin/rer' : shellQuote(paths.launcher);

// The managed runtime stays inside the install root; npx installs use PATH.
export function launcherScript(data) {
 return `#!/bin/sh
${marker}
# It uses the installer's private Node when present, otherwise Node on PATH.
root=${shellQuote(data)}
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
RER_INVOKED_AS=rer
if [ "$(command -v rer 2>/dev/null || true)" != "$0" ]; then RER_INVOKED_AS="$0"; fi
export RER_INVOKED_AS
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
