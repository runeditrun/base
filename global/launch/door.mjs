// What the front door means for one `rer dev`. With the door enabled, a fresh
// checkout whose pin supports it is set up at its door origin; a checkout
// already there needs the door running, which `rer dev` brings back only for
// the registry the door recorded (a fleet agent or a test with its own
// RER_DOOR_DIR or RER_SERVERS_DIR never starts the owner's door). --port,
// --host and --direct always mean direct mode.
import { doorProtocol, doorSite, readDoorState, runningDoor } from '../../cli/door.mjs';
import { startDoor } from '../door/control.mjs';
import { ownsRegistry } from '../door/policy.mjs';
import { LaunchFailure } from './failure.mjs';

const has = (args, flag) => args.includes(flag);

export async function doorPlan(described, args, env) {
 const capable = described?.door?.protocol === doorProtocol;
 const direct = has(args, '--direct') || has(args, '--port') || has(args, '--host');
 const state = await readDoorState(env).catch(() => undefined), door = state?.door;
 const running = door?.enabled ? await runningDoor(env).catch(() => undefined) : undefined;
 const protocol = running?.protocol ?? door?.protocol;
 const known = Boolean(door?.enabled) && protocol === doorProtocol;
 const note = door?.enabled && !known ? `The front door speaks protocol ${protocol}, which this rer does not know, so this checkout stays direct. Run rer door restart.` : undefined;
 const saved = Boolean(described?.local?.origin && doorSite(described.local.origin));
 return { door, known, note, freshAtDoor: known && capable && !direct, atDoor: !direct && (saved || has(args, '--door')) };
}

// Bring an enabled door back before a door-mode checkout starts.
export async function bringBackDoor(plan, env, report) {
 if (!plan.atDoor || !plan.door?.enabled || !plan.known) return;
 if (await runningDoor(env)) return;
 if (!ownsRegistry(plan.door, env)) {
  report({ phase: 'note', message: 'the front door is not running and this shell uses another RER_DOOR_DIR or RER_SERVERS_DIR than the one it recorded, so it was not started' });
  return;
 }
 report({ phase: 'door', message: 'starting the front door (it was not running)' });
 try { await startDoor(env); } catch (error) { throw new LaunchFailure(error.exitCode ?? 1, error.message); }
}
