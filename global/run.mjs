// rer run SCRIPT [ARGS]: `pnpm run SCRIPT ARGS` in a checkout, with the pnpm
// and Node it pins. rer keeps both in its own cache, off PATH, so a project's
// documented `pnpm run ...` works as `rer run ...` right after rer install.
// --silent drops pnpm's "> package@version script" banner; the script's own output and errors stay.
// A script that runs Playwright gets the checkout's browser first, on first need.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { locate } from './checkout.mjs';

export const runUsage = `Usage: rer run [--cwd DIR] [SCRIPT [ARGS...]]
Runs a package.json script of this checkout as pnpm run SCRIPT ARGS would, with the
pnpm and Node the checkout pins (rer keeps them off PATH). Without SCRIPT it lists
the scripts. Where a project's docs say pnpm run X -- ARGS, run rer run X -- ARGS.
`;

// The checkout's pinned Node, when it differs from this one (RER_NODE_AUTO=0 keeps this one).
async function projectNode(root, env) {
 const { projectNodePin, installedRuntime } = await import('../cli/node-runtime-discovery.mjs');
 const version = await projectNodePin(root);
 if (!version || version === process.versions.node || env.RER_NODE_AUTO === '0') return;
 const { downloadRuntime } = await import('../cli/node-runtime-download.mjs');
 const { missing, RerError } = await import('../cli/errors.mjs');
 let binary = await installedRuntime(version);
 try { binary ??= await downloadRuntime(version); }
 catch (error) { if (error instanceof RerError) throw error; throw missing(`This project pins Node ${version}, which could not be fetched (${error.message}). Retry with a working connection, or set RER_NODE_AUTO=0 to use Node ${process.versions.node}.`); }
 env.PATH = [dirname(binary), env.PATH].filter(Boolean).join(delimiter);
}

export async function runScript(args) {
 let cwd;
 if (['--help', '-h'].includes(args[0])) { process.stdout.write(runUsage); return 0; }
 if (args[0] === '--cwd') {
  cwd = args[1];
  if (!cwd?.trim() || cwd.startsWith('-')) { process.stderr.write(`A folder is required for --cwd.\n${runUsage}`); return 2; }
  args = args.slice(2);
 }
 const target = locate(cwd ? ['run', '--cwd', cwd] : ['run']);
 if (!target.root || !['first-party', 'independent'].includes(target.profile)) {
  process.stderr.write(`rer run runs inside a checkout: a folder with OPERATIONS.json at or above this one, or --cwd DIR.\n`);
  return 2;
 }
 let scripts = {};
 try { scripts = JSON.parse(await readFile(join(target.root, 'package.json'), 'utf8')).scripts ?? {}; } catch {}
 // pnpm run --silent hides pnpm's own missing-script error, so say it here, before any pnpm is fetched or spawned.
 if (args[0] && !args[0].startsWith('-') && !Object.hasOwn(scripts, args[0])) {
  process.stderr.write(`No script named ${args[0]} in this checkout. Scripts: ${Object.keys(scripts).join(', ') || '(none)'}\n`);
  return 2;
 }
 const { ensureProjectPnpm } = await import('../cli/project-pnpm.mjs');
 const { RerError } = await import('../cli/errors.mjs');
 try {
  await ensureProjectPnpm(target.root, { report: text => process.stderr.write(text + '\n') });
  await projectNode(target.root, process.env);
 } catch (error) { if (!(error instanceof RerError)) throw error; process.stderr.write(error.message + '\n'); return error.exitCode; }
 if (args[0] && /\bplaywright\b/.test(scripts[args[0]] ?? '')) {
  const code = await (await import('./browser-runtime.mjs')).browserPreflight(target.root, ['run']);
  if (code !== undefined) return code;
 }
 const child = spawn('pnpm', ['run', '--silent', ...args], { cwd: target.root, env: process.env, stdio: 'inherit' });
 const forward = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]));
 for (const [signal, handler] of forward) process.on(signal, handler);
 try {
  return await new Promise((resolve, reject) => {
   child.once('error', reject);
   child.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
 } finally { for (const [signal, handler] of forward) process.off(signal, handler); }
}
