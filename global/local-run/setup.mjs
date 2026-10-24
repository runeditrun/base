// Installation-scoped setup uses only signed acquisition and public rer verbs.
// Child output stays on this computer; callbacks receive closed phase fields.
import { createWriteStream } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { mailbox } from '../../cli/parse.mjs';
import { checkoutRepository } from '../cli/repository.mjs';
import { ownManifest, ownRoot } from '../package-info.mjs';
import { prepare } from '../launch/prepare.mjs';
import { launchDirectory } from '../launch/state.mjs';
import { failure } from './error.mjs';
import { run } from './process.mjs';

export async function setupRelease({ repository, commit, dir, ownerEmail, onPhase, anchors } = {}) {
 const started = Date.now();
 let step = 1, phase = 'get', commandError;
 const emit = (name, nextStep, error_code) => {
  phase = name; step = nextStep;
  return onPhase?.({ phase, step, total: 4, elapsed_ms: Date.now() - started, ...(error_code ? { error_code } : {}) });
 };
 const event = line => {
  try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : undefined; }
  catch { return undefined; }
 };
 try {
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)
   || !/^[a-f0-9]{40}$/.test(commit ?? '') || !mailbox(ownerEmail)
   || (dir !== undefined && (typeof dir !== 'string' || !dir.trim()))) throw failure('refused');
  const checkout = resolve(dir ?? basename(repository));
  await emit('get', 1);
  const release = await checkoutRepository({ url: `https://github.com/${repository}`, root: checkout,
   directory: basename(checkout), release: commit, anchors, quiet: true });
  const entry = join(ownRoot, 'global/rer.mjs');
  await emit('install', 2);
  const installed = await run(process.execPath, [entry, 'install', '--json', '--non-interactive'], { cwd: checkout });
  if (installed.code !== 0) throw failure('install_failed');
  await emit('database', 3);
  // The normal launch preparer fills local defaults only for fresh/resumed
  // setup, preserving saved owners, settings and origins on repeated setup.
  const directory = await launchDirectory(checkout), children = new Set(), controller = new AbortController();
  const log = createWriteStream(join(directory, 'launch.log'), { flags: 'a', mode: 0o600 });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => {
   controller.abort(); for (const child of children) child.kill(name);
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  let prepared;
  try {
   prepared = await prepare({ root: checkout, args: ['--detach', '--json'], setupArgs: ['--owner-email', ownerEmail],
    env: process.env, directory, children, signal: controller.signal, report: () => {}, log: line => log.write(line + '\n') });
  } catch (error) {
   await prepared?.release?.();
   throw error;
  } finally {
   for (const [name, handler] of handlers) process.off(name, handler);
   log.end();
  }
  let ready = false;
  const output = line => {
   const value = event(line);
   if (value?.event === 'error') commandError = true;
   if (value?.event === 'ready') ready = true;
  };
  let result;
  try {
   await emit('start', 4);
   result = await run(process.execPath, [entry, 'dev', '--detach', '--json', '--non-interactive'], { cwd: checkout, onLine: output });
  } finally { await prepared.release?.(); }
  if (result.code !== 0 || commandError || !ready) throw failure('start_failed');
  await emit('ready', 4);
  return { outcome: 'ready', release_commit: release.commit, release_tag: release.tag, rer_version: ownManifest().version };
 } catch (error) {
  const code = typeof error.error_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.error_code)
   ? error.error_code : phase === 'install' ? 'install_failed' : phase === 'database' ? (error.exitCode === 3 ? 'needs_input' : 'database_failed') : phase === 'start' ? 'start_failed' : 'get_failed';
  await emit('failed', step, code);
  throw failure(code);
 }
}
