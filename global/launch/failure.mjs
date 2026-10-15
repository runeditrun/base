import { createRedaction, credentialValues } from '../../onboarding/redaction.mjs';

// A launch that stops with the dispatcher's own message (or the launcher's)
// and exit code. `event` keeps the dispatcher's JSON error event when it sent one.
export class LaunchFailure extends Error {
 constructor(exitCode, message, event) { super(message); this.exitCode = exitCode; this.event = event; }
}

// Native errors have no dispatcher exit code, but their message is still the
// cause of this launch's failure. Redact before transporting it to followers;
// a JSON caller must receive the same cause and recovery as a terminal caller.
export function workerFailure(error, { root, env = process.env }) {
 const redaction = createRedaction();
 redaction.addSecrets([...credentialValues(env), ...credentialValues(error?.event)]);
 const redact = text => redaction.redact(String(text).replace(/([#&]rer-dev=)[^&\s"'<>]+/g, '$1[REDACTED]'));
 const clean = value => typeof value === 'string' ? redact(value)
  : Array.isArray(value) ? value.map(clean)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
 const exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 && error.exitCode <= 255 ? error.exitCode : 1;
 const cause = redact(error?.message || error || 'The launch stopped before the app was ready.');
 const retry = `rer dev --cwd '${root.replaceAll("'", "'\\''")}'`;
 const message = `${cause}\nCorrect the cause, then run ${retry} again.`;
 const event = { version: 1, verb: 'dev', event: 'error', code: 'launch_failed', ...clean(error?.event), message, exitCode };
 return new LaunchFailure(exitCode, message, event);
}
