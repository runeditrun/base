import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { refuse } from './errors.mjs';

// A fleet's server limit as one current value its newest launcher controls.
// RER_SERVER_LIMIT_FILE names a file holding a positive integer, read afresh at
// every start; that value is the limit for the start and overrides this process's
// RER_SERVER_LIMIT and every running server's recorded limit, so a long-lived run
// that still exports an older RER_SERVER_LIMIT cannot cap the others. Unset, the
// start behaves as before. A file that cannot be read or holds anything else
// refuses the start: there is no silent fallback to another limit.
export async function serverLimitFile(env = process.env) {
 if (env.RER_SERVER_LIMIT_FILE === undefined) return undefined;
 const path = resolve(env.RER_SERVER_LIMIT_FILE);
 let text;
 try { text = await readFile(path, 'utf8'); }
 catch (error) { throw refuse(`Not started: RER_SERVER_LIMIT_FILE names ${path}, which cannot be read (${error.code ?? error.message}). Create it holding a positive whole number such as 10, or unset RER_SERVER_LIMIT_FILE.`); }
 const value = text.trim();
 if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw refuse(`Not started: ${path} (RER_SERVER_LIMIT_FILE) must hold one positive whole number such as 10, and holds ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)}. Fix the file, or unset RER_SERVER_LIMIT_FILE.`);
 return { path, limit: Number(value) };
}
