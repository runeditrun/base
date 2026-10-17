import { busyFailure } from './failures.mjs';

// A queued step the job queue never admitted is a busy machine, not a failed
// command: say what held it, the limit and the next step, in the same plain form
// as the server load guard (cli/server-resources.mjs).
const commandNames = new Set(['dev', 'setup', 'preview', 'build', 'deploy', 'verify']);

function waited(seconds) {
 return seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${Math.round(seconds)} seconds`;
}

export function busyMessage(result, { verb, maxWait }) {
 const command = commandNames.has(verb) ? `rer ${verb}` : 'the same command';
 const load = result.resources?.load, threshold = result.limits?.loadThreshold;
 if (result.reasonCodes?.includes('load') && Number.isFinite(load) && threshold !== undefined) {
  return `Not started: this computer is busy. Its 1-minute load is ${load.toFixed(1)} and jobs start only at ${threshold} or below; this step waited ${waited(maxWait)} for it to drop.\nTry again in a few minutes by running ${command} again, or start it anyway with a higher threshold, for example RER_JOBS_LOAD_THRESHOLD=${Math.ceil(Math.max(threshold, load) * 2)} ${command}.`;
 }
 return `Not started: the job queue did not admit this step within ${waited(maxWait)}: ${result.reason}.\nTry again in a few minutes by running ${command} again.`;
}

export const busyRefusal = (result, options) => busyFailure(busyMessage(result, options));
