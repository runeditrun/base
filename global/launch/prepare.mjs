// Zero-setup preparation, composed only of the pinned dispatcher's public
// verbs so it works on every pin: limit check, install when needed, setup with
// local answers when the checkout is not set up. It never prompts and never
// runs setup on a checkout that is set up, so a saved owner, origin or private
// settings are never changed. An install or setup this launcher started and
// that did not finish runs again on the next launch.
import { realpath } from 'node:fs/promises';
import { dispatcher, pinnedPackage } from '../checkout.mjs';
import { liveServers } from '../registry.mjs';
import { checkCapacity, personEnvironment, pinPolicy } from './capacity.mjs';
import { bringBackDoor, doorPlan } from './door.mjs';
import { LaunchFailure } from './failure.mjs';
import { describeCheckout, freePort, localOwner, needsInstall, portTaken, setupNeeded } from './facts.mjs';
import { claimPort, installState, savedPorts, setupState } from './state.mjs';
import { runVerb } from './steps.mjs';
import { localDefaults } from './local-defaults.mjs';
import { installPinned } from './install-pinned.mjs';

// The value given for a flag in the user's dev arguments.
export const flagValue = (args, flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };

// A worker passes the signal a stop aborts: no step starts after it, and the
// step running then is signalled through `children`. `doorStart`: the front
// door is starting this checkout on a visit, which never installs or sets up;
// an unprepared checkout is refused with the reason.
export async function prepare({ root, args, env, report, directory, log, children, signal, doorStart = false }) {
 // A checkout pinning the rer package whose node_modules lacks that version
 // installs it first (after the same quick server-limit check: a pin with
 // package mode has the person defaults); every step after this runs the
 // pinned package's verbs.
 let installed = false;
 if (pinnedPackage(root)?.ready === false) {
  if (doorStart) throw new LaunchFailure(3, `${root} is not installed, and the front door starts only prepared checkouts. Run rer dev in it once.`);
  const current = await pinPolicy(root, 'package');
  report({ phase: 'check', message: 'checking the server limit' });
  const capacity = await checkCapacity(await realpath(root), { ...env, ...personEnvironment(env, args, current) }, current);
  if (capacity.own) throw new LaunchFailure(3, `A server of ${root} is running, but its node_modules lacks the rer version it pins. Stop it with rer dev --stop, then run rer dev again.`);
  report({ phase: 'install', message: 'installing dependencies' });
  await recorded(directory, installState, () => installPinned(root, { env, output: text => log(text.trimEnd()), children, signal }));
  installed = true;
 }
 const checkout = await realpath(root), { mode, entry } = dispatcher(root);
 const described = await describeCheckout(root, entry, env, signal);
 const pin = await pinPolicy(root, mode, described);
 const added = personEnvironment(env, args, pin), childEnv = { ...env, ...added };
 const plan = await doorPlan(described, args, env);
 if (plan.note) report({ phase: 'note', message: plan.note });
 report({ phase: 'check', message: 'checking the server limit' });
 const capacity = await checkCapacity(checkout, childEnv, pin);
 if (capacity.own) { await bringBackDoor(plan, env, report); return { entry, added, own: capacity.own }; }
 const note = message => report({ phase: 'note', message });
 const step = (record, args, fields, env = childEnv) => recorded(directory, record, () => runVerb(entry, args, { root, env, note, log, children, signal }), fields);
 // Only this setup fills the seed's declared local defaults.
 const setupEnv = { ...childEnv, [localDefaults]: '1' };
 const unprepared = what => new LaunchFailure(3, `${checkout} is not ${what}, and the front door starts only prepared checkouts. Run rer dev in it once.`);
 if (!installed && await needsInstall(root, await installState.read(directory))) {
  if (doorStart) throw unprepared('installed');
  report({ phase: 'install', message: 'installing dependencies' });
  await step(installState, ['install']);
 }
 const last = await setupState.read(directory), setup = await setupNeeded(root, described, last);
 if (setup && doorStart) throw unprepared('set up');
 const host = flagValue(args, '--host'), hostArgs = host ? ['--host', host] : [];
 if (setup === 'resume') {
  // Saved settings hold an owner and origin; setup keeps them.
  report({ phase: 'setup', message: 'finishing this checkout\'s setup, keeping its saved owner and port' });
  await step(setupState, ['setup', ...hostArgs], {}, setupEnv);
 } else if (setup === 'fresh' && plan.freshAtDoor) {
  // With the door enabled, a fresh checkout is set up at its door origin.
  const owner = localOwner(checkout);
  report({ phase: 'setup', message: `setting up a local owner (${owner}) at its front-door address` });
  await step(setupState, ['setup', '--owner-email', owner, '--door'], { owner, door: true }, setupEnv);
  await bringBackDoor({ ...plan, atDoor: true }, env, report);
  return { entry, added };
 } else if (setup === 'fresh') {
  // An interrupted setup resumes on the port it chose while that port is free.
  // A port another process takes between choosing it and setup refusing it is
  // passed over for the next free one; a port the person passed is kept.
  const owner = localOwner(checkout), explicit = flagValue(args, '--port');
  let from = last?.port;
  for (let attempt = 1; ; attempt++) {
   const held = explicit ? [] : [...(await liveServers(childEnv)).map(record => record.port), ...await savedPorts(checkout, childEnv)];
   const { port, release } = explicit ? { port: Number(explicit) } : await freePort(held, port => claimPort(port, childEnv), from ? { ...childEnv, RER_DEV_PORT_FROM: String(from) } : childEnv);
   report({ phase: 'setup', message: `setting up a local owner (${owner}) on port ${port}` });
   try { await step(setupState, ['setup', '--owner-email', owner, '--port', String(port), ...hostArgs], { port, owner }, setupEnv); }
   catch (failure) {
    await release?.();
    if (explicit || attempt === 3 || failure.exitCode !== 4 || !await portTaken(port)) throw failure;
    report({ phase: 'note', message: `port ${port} was taken by another process; choosing another free port` });
    from = port + 1;
    continue;
   }
   // The claim lasts until the server registers the port: the caller releases it.
   return { entry, added, release };
  }
 }
 await bringBackDoor(plan, env, report);
 return { entry, added };
}

// Run one step with its record: 'running' while it runs (left so by a killed
// process), then 'done' or 'failed'.
async function recorded(directory, record, run, fields = {}) {
 await record.write(directory, { state: 'running', ...fields });
 let state = 'failed';
 try { await run(); state = 'done'; }
 finally { await record.write(directory, { state, ...fields }); }
}
