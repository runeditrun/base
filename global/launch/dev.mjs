// Zero-setup `rer dev` for a first-party checkout. With stdout not a terminal
// (an agent's shell tool) the preparation and start run in a detached worker
// and this command returns once the app is ready, leaving it running; in a
// terminal it stays in the foreground as the dispatcher's own dev does.
// --detach and --foreground override the choice.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dispatcher } from '../checkout.mjs';
import { delegate } from '../delegate.mjs';
import { ownRoot } from '../package-info.mjs';
import { LaunchFailure } from './failure.mjs';
import { describeCheckout } from './facts.mjs';
import { prepare } from './prepare.mjs';
import { printer } from './render.mjs';
import { stopLaunch } from './stop.mjs';
import { launchDirectory, liveWorker } from './state.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export async function launchDev(target) {
 const args = target.args.slice(1);
 if (args.includes('--detach') && args.includes('--foreground')) { process.stderr.write('Choose one of --detach and --foreground.\n'); return 2; }
 // --door-start: the front door is starting this checkout (internal).
 const doorStart = args.includes('--door-start');
 const devArgs = args.filter(arg => !['--detach', '--foreground', '--door-start'].includes(arg));
 // A pin from before the front door cannot move to it: say so in one line.
 if ((devArgs.includes('--door') || devArgs.includes('--direct')) && !await doorCapable(target.root)) {
  process.stderr.write('This checkout\'s pinned Base has no front-door support, so it stays direct. Refresh its Base to serve it through the door; rer door add still lists it and starts it on a visit.\n');
  return 2;
 }
 // An invocation the pinned dispatcher refuses goes straight to it, so the
 // refusal is its own, with nothing prepared first.
 if (!await accepted(target.root, devArgs)) return delegateDev(target);
 const checkout = await realpath(target.root), directory = await launchDirectory(checkout);
 if (devArgs.includes('--stop')) {
  try { return await stopLaunch(target, devArgs, { checkout, directory }); }
  catch (failure) { if (!(failure instanceof LaunchFailure)) throw failure; process.stderr.write(failure.message + '\n'); return failure.exitCode; }
 }
 const here = await realpath(process.cwd()).catch(() => undefined);
 const out = printer({ json: devArgs.includes('--json'), stopHint: `rer dev --stop${here === checkout ? '' : ` --cwd ${JSON.stringify(checkout)}`}`, keyless: doorStart });
 const detach = args.includes('--detach') || (!args.includes('--foreground') && !process.stdout.isTTY);
 return detach ? detached(target, devArgs, directory, out, doorStart) : foreground(target, devArgs, directory, out, doorStart);
}

// Preparation can install a pin whose entry is another global launcher. Keep
// the caller's lifetime flags across that handoff. The internal front-door
// marker reaches other launchers, but never the public dispatcher.
function delegateDev(target) {
 const { launcher } = dispatcher(target.root);
 return delegate(target, launcher ? target.args : target.args.filter(arg => arg !== '--door-start'));
}

async function doorCapable(root) {
 try { return Boolean((await describeCheckout(root, dispatcher(root).entry, process.env)).door); } catch { return true; }
}

async function accepted(root, devArgs) {
 const parser = dispatcher(root).mode === 'vendored' ? join(root, 'scripts/base-cli/cli/parse.mjs') : join(ownRoot, 'cli/parse.mjs');
 if (!existsSync(parser)) return true;
 try { (await import(pathToFileURL(parser).href)).parse(['dev', ...devArgs], process.cwd()); return true; } catch { return false; }
}

async function foreground(target, devArgs, directory, out, doorStart) {
 const holder = await liveWorker(directory);
 if (holder) {
  out.attaching(holder.startedAt);
  const code = await follow(directory, holder.token, out, { quiet: true });
  if (code !== 0) return code;
 }
 const log = createWriteStream(join(directory, 'launch.log'), { flags: 'a', mode: 0o600 });
 let prepared;
 // The same progress lines as a detached launch while install or setup runs.
 const heartbeat = setInterval(() => out.heartbeat(), 1000);
 try { prepared = await prepare({ root: target.root, args: devArgs, env: process.env, report: fields => out.phase(fields), directory, log: text => log.write(text + '\n'), children: new Set(), doorStart }); }
 catch (failure) { if (!(failure instanceof LaunchFailure)) throw failure; out.failure(failure); return failure.exitCode; }
 finally { clearInterval(heartbeat); log.end(); }
 Object.assign(process.env, prepared.added);
 return delegateDev(target);
}

async function detached(target, devArgs, directory, out, doorStart) {
 let token, worker;
 const holder = await liveWorker(directory);
 if (holder) { token = holder.token; out.attaching(holder.startedAt); }
 else {
  token = randomUUID();
  // The worker ends itself for a stop that ran after this command started.
  worker = spawn(process.execPath, [workerPath, target.root, token, JSON.stringify(devArgs.filter(arg => arg !== '--json')), String(performance.timeOrigin), ...(doorStart ? ['door-start'] : [])], { cwd: target.root, env: process.env, detached: true, stdio: 'ignore' });
  worker.once('error', () => {});
  worker.unref();
 }
 return follow(directory, token, out, { worker });
}

// Print a worker's events until it is ready or has failed. A redirect means
// another worker already held this checkout's launch; follow that one.
async function follow(directory, token, out, { worker, quiet = false }) {
 const path = join(directory, `events-${token}.jsonl`);
 let offset = 0, rest = '', exited = false, missingSince, polls = 0;
 worker?.once('exit', () => { exited = true; });
 worker?.once('error', () => { exited = true; });
 for (;;) {
  let size = 0;
  try { size = (await stat(path)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size > offset) {
   const handle = await open(path, 'r');
   try { const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(size - offset), position: offset }); offset += bytesRead; rest += buffer.subarray(0, bytesRead).toString('utf8'); }
   finally { await handle.close(); }
   const lines = rest.split('\n'); rest = lines.pop();
   for (const line of lines) {
    const event = JSON.parse(line);
    if (event.event === 'phase') out.phase(event);
    else if (event.event === 'redirect') return event.token ? follow(directory, event.token, out, { quiet }) : missing(directory);
    else if (event.event === 'ready') { if (!quiet) out.ready(event.ready, event); return 0; }
    else if (event.event === 'failed') { out.failure(new LaunchFailure(event.exitCode, event.message, event.error)); return event.exitCode; }
   }
   continue;
  }
  // No terminal event: is the worker still there? (checked about once a second)
  const gone = worker ? exited : (polls++ % 4 === 0 ? (await liveWorker(directory))?.token !== token : false);
  if (gone || missingSince) {
   missingSince ??= Date.now();
   // Let a just-finished worker's last write land before calling it lost.
   if (Date.now() - missingSince > 1000) return missing(directory);
  }
  out.heartbeat();
  await delay(250);
 }
}

function missing(directory) {
 process.stderr.write(`rer dev: the launch stopped before it finished. Run rer dev again; its log is ${join(directory, 'launch.log')}.\n`);
 return 1;
}
