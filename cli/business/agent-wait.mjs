import { pause } from './api.mjs';
import { clean } from './agent-output.mjs';

export const exitStillWaiting = 75;
// What a follow result says. A change or an update is `{change|update: {state, ...}, next}`; next tells the agent what to do.
const stateOf = data => data.change?.state ?? data.update?.state ?? data.import?.state ?? data.state;
const finished = new Set(['live', 'failed', 'refused', 'done']);
const stops = new Set(['publish', 'done', 'ask_owner']);

/** Poll `follow()` every interval until the work ends or the timeout passes, saying each state change through `say`.
 * `publishing` waits through next=publish (a publish just made is not done yet): only live, done, ask_owner, failed or
 * refused end it. Returns { data, ended }; ended is false when the timeout ran out first. */
export async function waitFor(follow, { say, timeout = 1800, interval = 15, publishing = false, from }) {
 const deadline = Date.now() + timeout * 1000;
 let last = from, data;
 for (;;) {
  data = await follow();
  const state = stateOf(data), next = data.next;
  if (state !== last) say(`${clean(state ?? 'unknown', 60)}${typeof data.change?.title === 'string' ? ` (${clean(data.change.title, 100)})` : ''}`);
  last = state;
  const over = finished.has(state) || next === 'ask_owner' || next === 'done' || !publishing && stops.has(next) || state === undefined && next === undefined;
  if (over) return { data, ended: true };
  if (Date.now() + interval * 1000 > deadline) return { data, ended: false };
  await pause(interval * 1000);
 }
}
export const failedState = data => ['failed', 'refused'].includes(stateOf(data));
export const stateName = stateOf;
