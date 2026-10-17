import { join } from 'node:path';
import { alive } from './identity.mjs';
import { readJson } from './storage.mjs';

// Called only under the queue's transaction lock. Config is authoritative;
// without it every client uses the largest request from the same live members.
export async function sharedSlots(state, member, register = true) {
  const members = [];
  for (const item of state.slotMembers ?? []) {
    if (item.owner.token !== member.owner.token && await alive(item.owner)) members.push(item);
  }
  if (register) members.push(member);
  const disk = await readJson(join(member.directory, 'config.json'), {});
  if (disk.slots !== undefined && (!Number.isInteger(disk.slots) || disk.slots < 1))
    throw Error('Invalid job queue slots in config.json');
  state.slotMembers = members;
  state.slots = disk.slots ?? Math.max(1, ...members.map(item => item.slots));
  return state.slots;
}
