// Where a user install lives. Data: ${XDG_DATA_HOME:-$HOME/.local/share}/rer,
// as immutable versions/<version>-<digest8> directories and a `current` link.
// Launcher: rer in the bin folder, using the installer's private Node when present.
// The bin folder follows the data folder, so a redirected install never writes
// the account's own ~/.local/bin: RER_BIN_DIR, else XDG_BIN_HOME, else the bin
// beside a redirected XDG_DATA_HOME (its ../bin), else $HOME/.local/bin.
import { readFile, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function binDirectory(env = process.env, home = env.HOME || homedir()) {
 if (env.RER_BIN_DIR) return resolve(env.RER_BIN_DIR);
 if (env.XDG_BIN_HOME) return resolve(env.XDG_BIN_HOME);
 if (env.XDG_DATA_HOME) return join(dirname(resolve(env.XDG_DATA_HOME)), 'bin');
 return join(home, '.local/bin');
}

export function layout(env = process.env) {
 const home = env.HOME || homedir();
 const data = join(env.XDG_DATA_HOME || join(home, '.local/share'), 'rer');
 const bin = binDirectory(env, home);
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

const launcherRoot = text => text.split('\n')[1] === marker ? /^root='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]?.replaceAll(`'\\''`, "'") ?? null : undefined;

// 'absent', 'ours' (with the install root it runs), or 'foreign'.
export async function launcherOwner(path) {
 let info;
 try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
 if (!info.isFile()) return { state: 'foreign' };
 const text = await readFile(path, 'utf8'), root = launcherRoot(text);
 if (root === undefined) return { state: 'foreign' };
 return { state: 'ours', root: root ?? undefined, text };
}

// The same answer, read synchronously, for the lines a command prints.
export function launcherWritten(path) {
 try { return launcherRoot(readFileSync(path, 'utf8')) !== undefined; } catch { return false; }
}

export async function installRecord(paths) {
 try { return JSON.parse(await readFile(paths.record, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
