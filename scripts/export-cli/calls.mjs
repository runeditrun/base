// Conversion of the commands outside package.json and OPERATIONS.json (see
// cli/package-calls.mjs): delivery operations, the shell scripts they and CI
// workflows run, and workflow lines. `node scripts/rer.mjs VERB` becomes
// `pnpm exec rer VERB`, and paths into the vendored copy name the installed
// package. Before node_modules holds the pin there is no rer to exec, so the
// first call where nothing has installed yet (`pnpm install`, `rer install`)
// runs the frozen install first: inline when the call starts its command, or
// inside `sh -c` when something prefixes it (env assignments, `env -i`), so the
// prefix still covers both.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calledScripts, operationFiles, operationSources, workflowSources } from '../../cli/package-calls.mjs';
import { packageName } from '../../cli/package-mode.mjs';

const entry = /\bnode\s+(?:\.\/)?scripts\/(rer\.mjs|base-onboarding\/queued-entry\.mjs)(?![\w./-])([^\n&|;<>]*)/g;
const installs = /\bpnpm\s+(?:install|i|run\s+deps|deps)(?![\w:-])|\brer\s+install\b/;
// A JavaScript script that installs: a spawn of pnpm install.
const spawnsInstall = /(['"])pnpm\1\s*,\s*\[\s*(['"])(?:install|i)\2/;
// Text before a call that ends at the start of a command.
const commandStart = /(?:^|&&|;|\n|\(|\{|\bthen|\bdo|\belse)\s*$/;
const frozen = 'pnpm install --frozen-lockfile';
const shellScript = /\.(?:sh|bash)$/;

// One command text; `state.installed`: an earlier command already installed.
export function rewriteCommands(text, state) {
 let rewritten = '', last = 0;
 for (const match of text.matchAll(entry)) {
  const before = text.slice(0, match.index), [, file, args] = match;
  const command = file === 'rer.mjs' ? 'pnpm exec rer' : 'pnpm exec rer queue';
  let replacement;
  if (state.installed || installs.test(rewritten + text.slice(last, match.index))) replacement = command + args;
  else if (commandStart.test(before.replace(/\\\n/g, ' '))) replacement = `${frozen} && ${command}${args}`;
  else replacement = `sh -c '${frozen} && exec ${command} "$@"' sh${args}`;
  rewritten += text.slice(last, match.index) + replacement;
  last = match.index + match[0].length;
 }
 rewritten = (rewritten + text.slice(last))
  .replace(/(?:\.\/)?scripts\/base-onboarding\//g, `node_modules/${packageName}/onboarding/`)
  .replace(/(?:\.\/)?scripts\/base-cli\//g, `node_modules/${packageName}/`);
 if (installs.test(rewritten)) state.installed = true;
 return rewritten;
}

// A workflow file, line by line: each job starts with nothing installed; a
// `key: value` line rewrites its value and a block scalar its whole block.
export function rewriteWorkflow(text) {
 const lines = text.split('\n'), out = [];
 let state = { installed: false }, jobsIndent, inJobs = false;
 const indent = line => line.length - line.trimStart().length;
 for (let index = 0; index < lines.length; index++) {
  const line = lines[index];
  if (/^jobs:\s*$/.test(line)) { inJobs = true; jobsIndent = undefined; out.push(line); continue; }
  if (inJobs && line.trim() && !line.trimStart().startsWith('#')) {
   if (indent(line) === 0) inJobs = false;
   else if ((jobsIndent ??= indent(line)) === indent(line)) state = { installed: false };
  }
  if (!line.trim() || line.trimStart().startsWith('#')) { out.push(line); continue; }
  const pair = /^(\s*(?:-\s+)?[\w$.{}-]+:\s*)(.*)$/.exec(line);
  if (pair && /^[|>][-+]?\s*$/.test(pair[2])) {
   let end = index + 1;
   while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > indent(line))) end++;
   const block = lines.slice(index + 1, end).join('\n');
   out.push(line, ...rewriteCommands(block, state).split('\n'));
   index = end - 1;
   continue;
  }
  if (pair) { out.push(pair[1] + rewriteCommands(pair[2], state)); continue; }
  const item = /^(\s*-\s+)(.*)$/.exec(line);
  out.push(item ? item[1] + rewriteCommands(item[2], state) : rewriteCommands(line, state));
 }
 return out.join('\n');
}

// Every file these commands live in, rewritten: Map(path -> text) of those
// that change. Operations run setup first; a shell script is rewritten as of
// its first call (its own calls install first unless that call came after an
// install), and a script that installs (shell or JavaScript) counts as an
// install for what follows.
export async function planCalls(root, json) {
 const files = new Map(), scripts = new Map();
 const script = async (path, state) => {
  if (!scripts.has(path)) {
   const own = { installed: state.installed }, before = await readFile(join(root, path), 'utf8');
   if (shellScript.test(path)) {
    const after = rewriteCommands(before, own);
    if (after !== before) files.set(path, after);
   }
   scripts.set(path, own.installed || installs.test(before) || spawnsInstall.test(before));
  }
  if (scripts.get(path)) state.installed = true;
 };
 for (const source of await operationSources(root)) {
  const value = structuredClone(source.value), operations = operationFiles.find(entry => entry.file === source.file).operations(value), state = { installed: false };
  for (const name of Object.keys(operations).sort((a, b) => (b === 'setup') - (a === 'setup'))) {
   if (typeof operations[name] !== 'string') continue;
   for (const path of await calledScripts(root, operations[name])) await script(path, state);
   operations[name] = rewriteCommands(operations[name], state);
  }
  const after = json(value, source.text);
  if (JSON.stringify(value) !== JSON.stringify(source.value)) files.set(source.file, after);
 }
 for (const source of await workflowSources(root)) {
  for (const path of await calledScripts(root, source.text)) await script(path, { installed: false });
  const after = rewriteWorkflow(source.text);
  if (after !== source.text) files.set(source.file, after);
 }
 return files;
}
