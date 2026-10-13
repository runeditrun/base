// Resolve the checkout's package manager before its own rer can be loaded.
// The verified cache is private to rer; the resulting PATH travels to children.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { cachedPnpm, downloadPnpm } from './pnpm-runtime.mjs';
import { missing, RerError } from './errors.mjs';
import { shellQuote } from './node-runtime-cache.mjs';
import { probePnpm } from './pnpm-probe.mjs';
import { shared } from './shared.mjs';

export async function projectPnpmPin(root) {
 let pkg;
 try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); } catch {}
 const pin = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha\d+\.[0-9a-f]+)?$/.exec(pkg?.packageManager ?? '')?.[1];
 if (!pin) throw missing('This first-party checkout must declare an exact pnpm version in package.json packageManager. Correct that declaration, then rerun rer.');
 return pin;
}
async function probe(root, env, signal, store) {
 try { return await probePnpm(root, store, signal, env); }
 catch (error) { if (signal?.aborted) throw error; return undefined; }
}
export async function ensureProjectPnpm(root, options = {}) {
 if (options.store) return ensure(root, options);
 // Global bootstrap has no adapter or lifecycle store yet. Give it the same
 // command custody, with a temporary log and cancellation lasting through the
 // download, both probes, and cleanup.
 const cancellation = new AbortController();
 const signal = AbortSignal.any([options.signal, cancellation.signal].filter(Boolean));
 let termination, directory, store;
 const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => { termination ??= name; cancellation.abort(name); }]));
 for (const [name, handler] of handlers) process.on(name, handler);
 try {
  // Invalid manifests refuse before acquiring command custody or tools.
  const pin = await projectPnpmPin(root);
  directory = await mkdtemp(join(tmpdir(), 'rer-prerequisites-'));
  const { createCommands } = await shared('commands.mjs');
  store = await createCommands(directory, { logs: [] }, { terminal: () => {} });
  store.setCommandSignal(signal);
  return await ensure(root, { ...options, signal, store }, pin);
 } finally {
  try { await store?.closeCommands(); if (directory) await rm(directory, { recursive: true, force: true }); }
  finally { for (const [name, handler] of handlers) process.removeListener(name, handler); }
  if (termination) throw new RerError('cancelled', `Stopped by ${termination} after owned children were stopped.`, termination === 'SIGINT' ? 130 : 143);
 }
}
async function ensure(root, { env = process.env, signal, report = () => {}, store }, pin) {
 pin ??= await projectPnpmPin(root);
 if (await probe(root, env, signal, store) === pin) return env;
 let directory = await cachedPnpm(pin, env);
 if (!directory) {
  report(`Fetching pnpm ${pin} for this project; rer keeps it in its own cache.`);
  try { directory = await downloadPnpm(pin, signal, { env }); }
  catch (error) {
   if (signal?.aborted || error instanceof RerError) throw error;
   const prefix = join(env.HOME || homedir(), '.rer', 'pnpm', `manual-${pin}`);
   throw missing(`pnpm ${pin} could not be fetched (${error.message}). Retry with a working connection, or run in this shell: npm install --prefix ${shellQuote(prefix)} --no-save pnpm@${pin} && export PATH=${shellQuote(join(prefix, 'node_modules/.bin'))}:"$PATH"`);
  }
 }
 // Select the verified pnpm before any tool beside Node. Its shim still finds
 // this process's Node before the caller's PATH, but cannot be shadowed by a
 // different pnpm installed in that Node's bin directory.
 const supplied = { ...env, PATH: [directory, dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter) };
 if (await probe(root, supplied, signal, store) !== pin) throw missing(`The verified pnpm ${pin} did not report the project version. Run ${shellQuote(join(directory, 'pnpm'))} --version to inspect it, then rerun rer.`);
 Object.assign(env, supplied);
 return env;
}
