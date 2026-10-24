// One launch's guide: the phases it has reached, posted in order, and the
// printer wrapper that feeds it from the launch's own events.
import { ownManifest } from '../package-info.mjs';
import { errorCode, guideEvent, phases, platforms, stepOf, wireVersion } from './events.mjs';
import { createSender } from './send.mjs';

// `announced`: an earlier process of this same command (rer dev <repo> fetching
// the app) already posted `get`. `startedAt` is when the command began.
export function guideSession({ code, env = process.env, startedAt = performance.timeOrigin, announced = false }) {
 const os = platforms.includes(process.platform) ? process.platform : undefined;
 const sender = os ? createSender(code, env) : { send() {}, async settle() {} };
 const version = wireVersion(ownManifest().version);
 let reached = announced ? 0 : -1, finished = false, handedOff = false;
 // `at`: the phase a failure stopped in, which `step` counts.
 const post = (phase, { at = phase, error } = {}) => sender.send(guideEvent({ phase, step: stepOf(at), elapsed: Math.max(0, Math.round(Date.now() - startedAt)), code: error, version, os }));
 return {
  // Entering a phase also enters every earlier one not yet announced, so a
  // launch that skips install (already installed) still shows it passed.
  phase(name) {
   const to = phases.indexOf(name);
   if (finished || to <= reached) return;
   for (let i = reached + 1; i <= to; i++) post(phases[i]);
   reached = to;
   if (name === 'ready') finished = true;
  },
  fail(exitCode) {
   if (finished) return;
   finished = true;
   const at = phases[Math.max(reached, 0)], failure = errorCode(at, exitCode);
   post('failed', { at, error: failure });
   // The terminal gets the same two closed words the guide page gets.
   process.stderr.write(`RER_GUIDE_FAILED phase=${at} error_code=${failure}\n`);
  },
  // The command ended with `exitCode` without the app reaching ready.
  end(exitCode) { if (!finished && exitCode) this.fail(exitCode); },
  // Another rer process runs the rest of this launch and posts its own events:
  // its arguments and environment carry the code and this command's clock.
  delegate() {
   finished = true;
   return { args: ['--guide', code], env: { ...process.env, RER_GUIDE_STARTED_AT: String(Math.round(startedAt)) } };
  },
  // The app is handed to the checkout's own dispatcher, in this process: its
  // readiness is seen where it prints it. A pinned package's launcher keeps
  // running after its import resolves, so this guide ends with the process.
  handOff(run) {
   this.phase('start');
   watchReady(process.stdout, () => this.phase('ready'));
   handedOff = true;
   process.once('beforeExit', () => { this.end(process.exitCode ?? 0); return sender.settle(); });
   return run();
  },
  // This command returned `exitCode` (or threw). Settled here unless the app
  // was handed off, which settles when the process has nothing left to do.
  finish(exitCode, threw) {
   if (handedOff && !threw) return;
   this.end(exitCode);
   return sender.settle();
  },
 };
}

// The guide of this command: the code it was given, and the clock and `get`
// announcement of the rer process that started it (rer dev <repo> fetches the
// app, then runs this command inside the clone). Neither value is kept in the
// environment the app's own commands inherit.
export function launchGuide(code, env = process.env) {
 const startedAt = Number(env.RER_GUIDE_STARTED_AT);
 delete env.RER_GUIDE_STARTED_AT;
 const known = Number.isSafeInteger(startedAt) && startedAt > 0;
 return guideSession({ code, env, ...(known ? { startedAt, announced: true } : {}) });
}

// The same printer, plus the guide: its install, setup and start phases and its
// ready and failure move the guide on.
const guidePhases = { install: 'install', setup: 'database', start: 'start' };
export function guidedPrinter(out, guide) {
 return {
  ...out,
  guide,
  phase(fields) { out.phase(fields); if (guidePhases[fields.phase]) guide.phase(guidePhases[fields.phase]); },
  ready(...args) { out.ready(...args); guide.phase('ready'); },
  failure(failure) { out.failure(failure); guide.fail(failure.exitCode); },
 };
}

// A terminal launch hands the app to the checkout's own dispatcher in this
// process, so its readiness is seen where it is printed: the RER_READY line, or
// the ready event under --json. The output passes through unchanged.
export function watchReady(stream, onReady) {
 const write = stream.write;
 let seen = false;
 stream.write = function (chunk, ...rest) {
  if (!seen) {
   const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
   if (/^RER_READY /m.test(text) || text.includes('"event":"ready"')) { seen = true; try { onReady(); } catch {} }
  }
  return write.call(this, chunk, ...rest);
 };
 return () => { stream.write = write; };
}
