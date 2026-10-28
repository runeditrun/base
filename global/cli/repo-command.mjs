import { createWriteStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '../../cli/parse.mjs';
import { shellQuote } from '../../cli/node-runtime-cache.mjs';
import { install } from './install.mjs';
import { showBudget } from '../../cli/run-transfers.mjs';
import { checkoutRepository, runCommand } from './repository.mjs';
import { ownRoot } from '../package-info.mjs';
import { prepare } from '../launch/prepare.mjs';
import { launchDirectory } from '../launch/state.mjs';

export async function repoCommand(request) {
 const { verb, directory, args } = request;
 parse([verb, ...args]); // Refuse invalid options before installation or cloning.
 showBudget(args);
 const installed = await install({ quiet: true });
 if (installed !== 0) return installed;
 await checkoutRepository(request);
 const root = await realpath(request.root);
 const next = command => `cd ${shellQuote(directory)} && rer ${command}`;
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
  const code = await runCommand(process.execPath, [entry, verb, ...args], { cwd: root,
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
