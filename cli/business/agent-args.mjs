import { readFile } from 'node:fs/promises';
import { aliases } from './agent-table.mjs';

const booleans = new Set(['json', 'wait', 'publish', 'help']);
const numbers = new Set(['timeout', 'interval']);
export class Usage extends Error {}

const snake = flag => (aliases[flag] ?? flag).replaceAll('-', '_');
// A value that starts like JSON is sent as JSON; @FILE reads a JSON (or text) file. Anything else is text.
async function value(flag, text) {
 let source = text;
 if (text.startsWith('@')) {
  try { source = (await readFile(text.slice(1), 'utf8')).trim(); } catch { throw new Usage(`Could not read ${text.slice(1)} for --${flag}.`); }
  if (!/^[[{]/.test(source)) return source;
 }
 if (!/^[[{]/.test(source)) return source;
 try { return JSON.parse(source); } catch { throw new Usage(`--${flag} is not valid JSON.`); }
}

/** Flags and bare words to { arguments, control, positional }. Flags become arguments (kebab-case to snake_case); --json,
 * --wait, --publish, --timeout SECONDS and --interval SECONDS steer rer itself; --args JSON adds a whole arguments object. */
export async function parseArguments(args) {
 const control = {}, named = {}, words = [];
 for (let index = 0; index < args.length; index++) {
  const token = args[index];
  if (token === '-h') { control.help = true; continue; }
  if (!token.startsWith('--') || token === '--') { words.push(token); continue; }
  const [flag, inline] = token.slice(2).split(/=(.*)/s, 2);
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(flag)) throw new Usage(`Unknown flag ${token.slice(0, 40)}.`);
  if (booleans.has(flag)) { control[flag] = true; continue; }
  const text = inline ?? args[++index];
  if (text === undefined || inline === undefined && text.startsWith('--')) throw new Usage(`A value is required for --${flag}.`);
  const target = numbers.has(flag) ? control : named;
  const key = numbers.has(flag) ? flag : snake(flag);
  if (Object.hasOwn(target, key)) throw new Usage(`Repeated flag --${flag}.`);
  if (numbers.has(flag)) {
   const number = Number(text);
   if (!Number.isFinite(number) || number <= 0 || number > 86400) throw new Usage(`--${flag} takes a number of seconds.`);
   control[flag] = number;
  } else named[key] = await value(flag, text);
 }
 const { args: whole, ...rest } = named;
 if (whole !== undefined && (whole === null || typeof whole !== 'object' || Array.isArray(whole))) throw new Usage('--args takes a JSON object.');
 for (const key of Object.keys(whole ?? {})) if (Object.hasOwn(rest, key)) throw new Usage(`${key} is given both as a flag and in --args.`);
 return { arguments: { ...whole, ...rest }, control, words };
}

/** Put the bare words into the row's positional argument: free text for a sentence, exactly one word for an identifier. */
export function place(row, parsed) {
 const { words } = parsed, into = row.positional;
 if (!words.length) return parsed.arguments;
 if (!into) throw new Usage(`Unexpected word "${words[0].slice(0, 40)}". Pass values as --flag VALUE.`);
 if (Object.hasOwn(parsed.arguments, into)) throw new Usage(`${into} is given both as a flag and as words.`);
 if (into !== 'intent' && words.length > 1) throw new Usage(`Expected one ${into.replaceAll('_', '-')}, got ${words.length} words.`);
 return { ...parsed.arguments, [into]: words.join(' ') };
}

export function missing(row, argumentsObject) {
 return (row.required ?? []).filter(name => argumentsObject[name] === undefined);
}
