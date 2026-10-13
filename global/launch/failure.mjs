// A launch that stops with the dispatcher's own message (or the launcher's)
// and exit code. `event` keeps the dispatcher's JSON error event when it sent one.
export class LaunchFailure extends Error {
 constructor(exitCode, message, event) { super(message); this.exitCode = exitCode; this.event = event; }
}
