import { RerError } from '../errors.mjs';

/** One deadline for the whole growth run (both sizes). `enter` names the phase work is in; `within` rejects when the
 * deadline passes while that work is still running, naming the size, phase, table and flow it stopped in. */
export function runClock(timeoutSeconds) {
 const state = { size: undefined, phase: 'starting', table: undefined, flow: undefined };
 let timer;
 const expired = new Promise((_, reject) => {
  timer = setTimeout(() => {
   const where = [state.size && `the ${state.size} size`, state.phase, state.table && `table ${state.table}`, state.flow && `flow ${state.flow}`].filter(Boolean).join(', ');
   reject(new RerError('size_timeout', `rer size stopped after ${timeoutSeconds} s (budget.timeoutSeconds) in ${where}. Raise budget.timeoutSeconds, or declare fewer rows.`, 1));
  }, timeoutSeconds * 1000);
  timer.unref?.();
 });
 expired.catch(() => {});
 return {
  enter(size, phase, table, flow) { Object.assign(state, { size, phase, table, flow }); },
  within: work => Promise.race([work, expired]),
  stop: () => clearTimeout(timer),
 };
}
