// The guide's progress events: the keys the platform accepts and nothing else.
// A launch moves through four phases, then ends ready or failed. `step`/`total`
// count those phases (total 4, so ready is step 4 of 4):
//   get       the app's code is on this computer (clone, or the checkout in place)
//   install   dependencies and the pinned tools are installed
//   database  the local database and first owner are set up
//   start     the app is starting
//   ready     the app answers (step 4 of 4)
//   failed    the launch stopped; `step` is the phase it stopped in
// An event holds no path, environment value, host or user name, link or error
// text: `error_code` is one of the closed list below, chosen from the phase and
// the exit code alone.
export const phases = Object.freeze(['get', 'install', 'database', 'start', 'ready']);
export const total = 4;
export const stepOf = phase => Math.min(phases.indexOf(phase) + 1, total);

// The closed error list, each with the fix the guide page can offer:
//   get_failed       the app could not be fetched or reused: check the network, the repository and git
//   install_failed   dependencies or tools did not install: check the network and free disk, run again
//   database_failed  local setup did not finish: run the same command again
//   start_failed     the app did not start: run the same command again
//   refused          rer declined to start: a free port, the server limit or disk space (the message names it)
//   needs_input      a setup answer is missing: the message names the field
//   stopped          the launch was stopped (Ctrl-C or rer dev --stop)
export const errorCodes = Object.freeze(['get_failed', 'install_failed', 'database_failed', 'start_failed', 'refused', 'needs_input', 'stopped']);

// Exit codes: 3 is a missing input, 4 a safety refusal, 130 and 143 an interrupt.
export function errorCode(phase, exitCode) {
 if ([130, 143].includes(exitCode)) return 'stopped';
 if (phase === 'get') return 'get_failed';
 if (exitCode === 4) return 'refused';
 if (exitCode === 3) return 'needs_input';
 return `${phase}_failed`;
}

// The version as the platform accepts it: 0.2.80, or 0.2.80-dev for a build
// from a commit (its commit id is long and random-looking, and stays off the wire).
export const wireVersion = version => /^\d+\.\d+\.\d+(?:-[a-z]+)?/.exec(version)?.[0] ?? 'unknown';

export const platforms = Object.freeze(['darwin', 'linux', 'win32']);

// Exactly the contract's keys, in its order. Only a code from the closed list
// goes out.
export function guideEvent({ phase, step, elapsed, code, version, os }) {
 return { v: 1, phase, step, total, elapsed_ms: elapsed, ...(errorCodes.includes(code) ? { error_code: code } : {}), rer_version: version, os };
}
