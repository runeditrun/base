import { createRedaction, credentialValues } from '../../onboarding/redaction.mjs';
import { rerWord } from '../cli/invocation.mjs';
import { shellQuote } from '../../cli/shell-word.mjs';

// A launch that stops with the dispatcher's own message (or the launcher's)
// and exit code. `event` keeps the dispatcher's JSON error event when it sent one.
export class LaunchFailure extends Error {
 constructor(exitCode, message, event) { super(message); this.exitCode = exitCode; this.event = event; }
}

// The shell keeps its working directories in PWD and OLDPWD: in the environment
// those two exact names hold folders, not credentials. Every other name, and
// every event field, keeps the shared credential rules.
const shellDirectories = new Set(['PWD', 'OLDPWD']);

// Native errors have no dispatcher exit code, but their message is still the
// cause of this launch's failure. Redact before transporting it to followers;
// a JSON caller must receive the same cause and recovery as a terminal caller.
export function workerFailure(error, { root, env = process.env }) {
 const redaction = createRedaction();
 const environment = Object.fromEntries(Object.entries(env).filter(([name]) => !shellDirectories.has(name)));
 redaction.addSecrets([...credentialValues(environment), ...credentialValues(error?.event)]);
 const redact = text => redaction.redact(String(text).replace(/([#&]rer-dev=)[^&\s"'<>]+/g, '$1[REDACTED]'));
 const clean = value => typeof value === 'string' ? redact(value)
  : Array.isArray(value) ? value.map(clean)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
 const exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 && error.exitCode <= 255 ? error.exitCode : 1;
 const cause = redact(error?.message || error || 'The launch stopped before the app was ready.');
 const retry = [rerWord(), 'dev', '--cwd', shellQuote(root)].join(' ');
 // The retry names this checkout, which can equal a registered secret: the
 // composed message passes through the same redaction as its cause.
 const message = redact(`${cause}\nCorrect the cause, then run ${retry} again.`);
 const event = { version: 1, verb: 'dev', event: 'error', code: 'launch_failed', ...clean(error?.event), message, exitCode };
 return new LaunchFailure(exitCode, message, event);
}

// A refusal from the setup of a checkout that is not set up yet: the pin's
// recovery `rer setup --port N` would ask for the owner rer dev chose itself,
// so the next step is rer dev on that port, which supplies the same defaults.
export function freshSetupRecovery(failure) {
 const next = text => typeof text === 'string' ? text.replace(/\brer setup --port (\d+)/g, `${rerWord()} dev --port $1`) : text;
 return new LaunchFailure(failure.exitCode, next(failure.message), failure.event && { ...failure.event, message: next(failure.event.message) });
}
