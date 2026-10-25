import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '../../cli/parse.mjs';
import { RerError } from '../../cli/errors.mjs';
import { shellQuote } from '../../cli/node-runtime-cache.mjs';
import { install } from './install.mjs';
import { rerWord } from './invocation.mjs';
import { launcherOwner, layout } from './layout.mjs';
import { pathAdvice } from './path-link.mjs';
import { checkoutRepository, runCommand } from './repository.mjs';
import { ownRoot } from '../package-info.mjs';
import { prepare } from '../launch/prepare.mjs';
import { launchDirectory } from '../launch/state.mjs';

// `openApp`: rer dev <repo> --open, which the launch in the clone carries out.
export async function repoCommand(request, { openApp = false } = {}) {
 const { verb, directory, args } = request;
 parse([verb, ...args]); // Refuse invalid options before installation or cloning.
 const paths = layout(), launcher = await launcherOwner(paths.launcher);
 const installed = await install({ quiet: true });
 if (installed !== 0) return installed;
 // The first step a person sees: getting the code (or reusing the clone).
 const report = message => args.includes('--json') ? process.stdout.write(JSON.stringify({ version: 1, verb, event: 'progress', phase: 'get', message }) + '\n') : process.stderr.write(`rer ${verb}: ${message}\n`);
 try { await checkoutRepository(request, { report }); }
 catch (error) {
  // A --json caller gets the refusal as data, with its stable code (git_missing).
  if (!(error instanceof RerError) || !args.includes('--json')) throw error;
  for (const event of [{ event: 'error', code: error.code, message: error.message, exitCode: error.exitCode }, { event: 'result', ok: false, exitCode: error.exitCode }]) process.stdout.write(JSON.stringify({ version: 1, verb, ...event }) + '\n');
  return error.exitCode;
 }
 const root = await realpath(request.root);
 if (launcher.state === 'absent') {
  const advice = await pathAdvice(paths);
  if (advice) process.stderr.write(advice + '\n');
 }
 // Next steps as the person's shell runs them now: an npx start, or a launcher
 // not on PATH yet, is named by the path that works.
 const next = command => `cd ${shellQuote(directory)} && ${rerWord()} ${command}`;
 if (verb === 'setup') {
  const state = await launchDirectory(root), children = new Set(), controller = new AbortController();
  const log = createWriteStream(join(state, 'launch.log'), { flags: 'a', mode: 0o600 });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { controller.abort(); for (const child of children) child.kill(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
   const result = await prepare({ root, args, setupArgs: args, env: process.env, directory: state, children, signal: controller.signal,
    report: fields => args.includes('--json') ? process.stdout.write(JSON.stringify({ version: 1, verb, event: 'progress', ...fields }) + '\n') : process.stderr.write(`rer setup: ${fields.message}\n`), log: text => log.write(text + '\n') });
   await result.release?.();
  } finally {
   for (const [signal, handler] of handlers) process.off(signal, handler);
   log.end();
  }
 } else {
  if (verb === 'dev' && !args.includes('--json')) process.stdout.write(`Restart: ${next('dev')}\n`);
  const entry = join(ownRoot, 'global/rer.mjs');
  const code = await runCommand(process.execPath, [entry, verb, ...args, ...(openApp ? ['--open'] : [])], { cwd: root, env: { ...process.env, RER_SHELL_CWD: process.cwd() },
   ...(verb === 'dev' ? { onInterrupt: () => runCommand(process.execPath, [entry, 'dev', '--stop'], { cwd: root }) } : {}),
  });
  if (code !== 0) return code;
 }
 if (verb !== 'dev') {
  const command = next(verb === 'install' ? 'setup' : 'dev');
  process.stdout.write(args.includes('--json') ? JSON.stringify({ version: 1, verb, event: 'next', command }) + '\n' : `Next: ${command}\n`);
 }
 return 0;
}
