// A custom deploy hook that deploys with the kit under its own state file returns
// that file as `state`. rer keeps a pointer to it beside its own records, so
// `rer deploy --remove` finds and removes what the hook deployed.
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { contained } from './project.mjs';
import { invalid } from './errors.mjs';
import { shared } from './shared.mjs';

const pointer = environment => join('.rer', 'deploy', `${environment}.hook.json`);

export async function rememberHookState(root, environment, state) {
 if (state === undefined) return;
 if (typeof state !== 'string' || !state) throw invalid('A deploy hook returns state as the path of its kit state file in this checkout.');
 const path = isAbsolute(state) ? relative(root, state) : state;
 await contained(root, path);
 const { privateDirectory, writePrivateFile } = await shared('private-files.mjs');
 await privateDirectory(root, ['.rer', 'deploy']);
 await writePrivateFile(join(root, pointer(environment)), JSON.stringify({ state: path }) + '\n');
}

// The hook's state file for this environment, or undefined when no hook named one.
export async function hookState(root, environment) {
 let text;
 try { text = await readFile(join(root, pointer(environment)), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
 let state;
 try { ({ state } = JSON.parse(text)); } catch { throw invalid(`${pointer(environment)} is malformed. Restore it, or remove it to fall back to rer's own deployment record.`); }
 await contained(root, state, { optional: true });
 return state;
}

export const forgetHookState = (root, environment) => rm(join(root, pointer(environment)), { force: true });
