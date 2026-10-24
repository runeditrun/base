// Zero-setup preparation, composed only of the pinned dispatcher's public
// verbs so it works on every pin: limit check, install when needed, setup with
// local answers when the checkout is not set up. It never prompts and never
// runs setup on a checkout that is set up, so a saved owner, origin or private
// settings are never changed. An install or setup this launcher started and
// that did not finish runs again on the next launch. Each line it reports names
// what runs: the server-limit check is quick and silent (a refusal says so),
// and setup's own steps are named as the pin's setup reaches them.
import { realpath } from 'node:fs/promises';
import { dispatcher, pinnedPackage } from '../checkout.mjs';
import { liveServers } from '../registry.mjs';
import { productName } from '../open.mjs';
import { checkCapacity, personEnvironment, pinPolicy } from './capacity.mjs';
import { bringBackDoor, doorPlan } from './door.mjs';
import { LaunchFailure, freshSetupRecovery } from './failure.mjs';
import { describeCheckout, freePort, needsInstall, portBusy, setupNeeded } from './facts.mjs';
import { zeroSetupOwner } from '../../onboarding/local/owner.mjs';
import { claimPort, claimedPorts, installState, savedPorts, setupState } from './state.mjs';
import { runVerb } from './steps.mjs';
import { localDefaults } from './local-defaults.mjs';
import { installPinned } from './install-pinned.mjs';

// The value given for a flag in the user's dev arguments.
export const flagValue = (args, flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };

// The steps a pin's setup names on stderr (onboarding/adapter-labels.mjs), as
// a person reads them, and the notes it prints between them.
const setupSteps = name => new Map([
 ['Building your application', `building ${name} (setup on this pin makes a production build to claim the first owner)`],
 ['Applying database migrations', 'applying database migrations'],
 ['Starting your application on this computer', `starting ${name} once to claim its first owner`],
 ['Claiming the first owner', 'claiming the first owner'],
]);
const setupNotes = new Map([
 ['Local process inspection did not answer; continuing with the exclusive checkout launch lock.', 'the process check did not answer within its bound; continuing under this checkout\'s launch lock'],
]);

// A worker passes the signal a stop aborts: no step starts after it, and the
// step running then is signalled through `children`. `doorStart`: the front
// door is starting this checkout on a visit, which never installs or sets up;
// an unprepared checkout is refused with the reason.
export async function prepare({ root, args, setupArgs = [], env, report, directory, log, children, signal, doorStart = false }) {
 const name = await productName(root) ?? 'the app';
 // A checkout pinning the rer package whose node_modules lacks that version
 // installs it first (after the same quick server-limit check: a pin with
 // package mode has the person defaults); every step after this runs the
 // pinned package's verbs.
 let installed = false;
 if (pinnedPackage(root)?.ready === false) {
  if (doorStart) throw new LaunchFailure(3, `${root} is not installed, and the front door starts only prepared checkouts. Run rer dev in it once.`);
  const current = await pinPolicy(root, 'package');
  const capacity = await checkCapacity(await realpath(root), { ...env, ...personEnvironment(env, args, current) }, current);
  if (capacity.own) throw new LaunchFailure(3, `A server of ${root} is running, but its node_modules lacks the rer version it pins. Stop it with rer dev --stop, then run rer dev again.`);
  report({ phase: 'install', message: `installing ${name}'s dependencies (pnpm install)` });
  await recorded(directory, installState, () => installPinned(root, { env, output: text => log(text.trimEnd()), children, signal }));
  installed = true;
 }
 const checkout = await realpath(root), { mode, entry } = dispatcher(root);
 const described = await describeCheckout(root, entry, env, signal);
 const pin = await pinPolicy(root, mode, described);
 const added = personEnvironment(env, args, pin), childEnv = { ...env, ...added };
 const plan = await doorPlan(described, args, env);
 if (plan.note) report({ phase: 'note', message: plan.note });
 const capacity = await checkCapacity(checkout, childEnv, pin);
 if (capacity.own) { await bringBackDoor(plan, env, report); return { entry, added, own: capacity.own }; }
 const note = message => report({ phase: 'note', message });
 // A step the pin's setup names twice in a row is reported once.
 let named;
 const setupStep = message => { named = undefined; report({ phase: 'setup', message }); };
 const steps = setupSteps(name), stepped = label => {
  if (steps.has(label) && steps.get(label) !== named) report({ phase: 'setup', message: named = steps.get(label) });
  else if (setupNotes.has(label)) note(setupNotes.get(label));
 };
 const step = (record, args, fields, env = childEnv) => recorded(directory, record, () => runVerb(entry, args, { root, env, note, step: stepped, log, children, signal }), fields);
 // Only this setup fills the seed's declared local defaults.
 const setupEnv = { ...childEnv, [localDefaults]: '1' };
 // Repository setup can supply the same owner/answer inputs as checkout setup.
 const extraSetup = setupArgs.filter((arg, i) => !['--json', '--non-interactive', '--port', '--host', '--door', '--owner-email'].includes(arg) && !['--port', '--host', '--owner-email'].includes(setupArgs[i - 1]));
 const ownerArgs = flagValue(setupArgs, '--owner-email') ? ['--owner-email', flagValue(setupArgs, '--owner-email')] : [];
 const unprepared = what => new LaunchFailure(3, `${checkout} is not ${what}, and the front door starts only prepared checkouts. Run rer dev in it once.`);
 if (!installed && await needsInstall(root, await installState.read(directory))) {
  if (doorStart) throw unprepared('installed');
  report({ phase: 'install', message: `installing ${name}'s dependencies (pnpm install)` });
  await step(installState, ['install']);
 }
 const last = await setupState.read(directory), setup = await setupNeeded(root, described, last);
 if (setup && doorStart) throw unprepared('set up');
 const host = flagValue(args, '--host'), hostArgs = host ? ['--host', host] : [];
 if (setup === 'resume') {
  // Saved settings hold an owner and origin; setup keeps them.
  setupStep(`finishing ${name}'s local setup, keeping its saved owner and port`);
  await step(setupState, ['setup', ...hostArgs, ...ownerArgs, ...extraSetup], {}, setupEnv);
 } else if (setup === 'fresh' && plan.freshAtDoor) {
  // With the door enabled, a fresh checkout is set up at its door origin.
  const owner = flagValue(setupArgs, '--owner-email') ?? zeroSetupOwner(checkout);
  setupStep(`setting up ${name}'s local database and owner (${owner}) at its front-door address`);
  await step(setupState, ['setup', '--owner-email', owner, '--door', ...extraSetup], { owner, door: true }, setupEnv);
  await bringBackDoor({ ...plan, atDoor: true }, env, report);
  return { entry, added };
 } else if (setup === 'fresh') {
  // A fresh checkout takes the first free port, skipping the ports other
  // checkouts use, keep or are setting up on (and the one above each, where
  // its run site goes). A port another process takes between choosing it and
  // setup or start using it is passed over for the next free one, and the
  // launch says so; a port the person passed is kept, and refused when busy.
  const owner = flagValue(setupArgs, '--owner-email') ?? zeroSetupOwner(checkout), explicit = flagValue(args, '--port');
  const choose = async from => {
   if (explicit) return { port: Number(explicit) };
   const servers = await liveServers(childEnv), saved = await savedPorts(checkout, childEnv), claimed = await claimedPorts(childEnv);
   const held = [...servers.flatMap(record => [record.port, sitePort(record.siteUrl)]), ...saved.flatMap(port => [port, port + 1]), ...claimed.map(port => port + 1)];
   return freePort(held, port => claimPort(port, childEnv), from ? { ...childEnv, RER_DEV_PORT_FROM: String(from) } : childEnv);
  };
  const setUp = async (port, message) => {
   setupStep(message);
   await step(setupState, ['setup', '--owner-email', owner, '--port', String(port), ...hostArgs, ...extraSetup], { port, owner }, setupEnv);
  };
  let from = last?.port;
  for (let attempt = 1; ; attempt++) {
   const { port, release } = await choose(from);
   try { await setUp(port, `setting up ${name}'s local database and owner (${owner}) on port ${port}`); }
   catch (failure) {
    await release?.();
    if (explicit || attempt === 5 || failure.exitCode !== 4 || !await portBusy(port)) throw failure instanceof LaunchFailure ? freshSetupRecovery(failure) : failure;
    note(`port ${port} is in use by another program; trying the next free port`);
    from = port + 1;
    continue;
   }
   // The claim lasts until the server registers the port: the caller releases
   // it. `move` is for a start that finds this port taken after setup.
   return { entry, added, release, port, move: explicit ? undefined : async taken => {
    const next = await choose(taken + 1);
    note(`port ${taken} was taken by another program after setup; moving ${name} to port ${next.port} (its data is kept)`);
    try { await setUp(next.port, `moving ${name} to port ${next.port}`); } catch (failure) { await next.release?.(); throw failure; }
    return next;
   } };
  }
 }
 await bringBackDoor(plan, env, report);
 return { entry, added };
}

const sitePort = url => { try { return Number(new URL(url).port) || undefined; } catch { return undefined; } };

// Run one step with its record: 'running' while it runs (left so by a killed
// process), then 'done' or 'failed'.
async function recorded(directory, record, run, fields = {}) {
 await record.write(directory, { state: 'running', ...fields });
 let state = 'failed';
 try { await run(); state = 'done'; }
 finally { await record.write(directory, { state, ...fields }); }
}
