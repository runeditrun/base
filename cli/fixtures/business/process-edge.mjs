import * as real from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
export * from 'node:child_process';
const fixture = fileURLToPath(new URL('./os-edge.mjs', import.meta.url));
const permitted = new Set(['/usr/bin/security', 'secret-tool', '/bin/launchctl', 'systemctl', '/usr/bin/caffeinate']);
function record(command, options) {
 const path = options?.env?.RER_TEST_KEYCHAIN_CALLS ?? process.env.RER_TEST_KEYCHAIN_CALLS;
 if (path && ['/usr/bin/security', 'secret-tool'].includes(command)) appendFileSync(path, 'keychain\n', { mode: 0o600 });
}
export function spawn(command, args, options) {
 if (!permitted.has(command)) throw Error('Unexpected OS credential/service command');
 record(command, options);
 return real.spawn(process.execPath, [fixture, command, ...args], options);
}
export function execFile(command, args, options, callback) {
 if (!permitted.has(command)) throw Error('Unexpected OS service command');
 record(command, options);
 return real.execFile(process.execPath, [fixture, command, ...args], options, callback);
}
