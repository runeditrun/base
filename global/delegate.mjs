// Run an invocation with the checkout's own rer, in this process. A pinned
// package runs it with its own rer command, so launching is its own too. A
// vendored or bundled dispatcher runs it exactly as `node scripts/rer.mjs ...`
// would from the project root: process.argv[1] is that file, so its Node-pin
// re-exec and queued child spawns behave as they do when it is run directly.
// The dispatcher sets process.exitCode itself.
import { pathToFileURL } from 'node:url';
import { dispatcher } from './checkout.mjs';

export async function delegate(target, args, { entryOnly = false } = {}) {
 const { entry, launcher } = dispatcher(target.root);
 if (target.root) process.chdir(target.root);
 const command = entryOnly ? entry : launcher ?? entry;
 process.argv = [process.argv[0], command, ...args];
 await import(pathToFileURL(command).href);
}
