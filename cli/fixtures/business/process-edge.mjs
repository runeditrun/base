import * as real from 'node:child_process';
import { fileURLToPath } from 'node:url';
export * from 'node:child_process';
const fixture = fileURLToPath(new URL('./os-edge.mjs', import.meta.url));
const permitted = new Set(['/usr/bin/security', 'secret-tool', '/bin/launchctl', 'systemctl', '/usr/bin/caffeinate']);
export function spawn(command, args, options) {
 if (!permitted.has(command)) throw Error('Unexpected OS credential/service command');
 if (command === '/usr/bin/security' && process.env.TEST_MACOS_KEYCHAIN) return real.spawn('security', args, options);
 return real.spawn(process.execPath, [fixture, command, ...args], options);
}
export function execFile(command, args, options, callback) {
 if (!permitted.has(command)) throw Error('Unexpected OS service command');
 return real.execFile(process.execPath, [fixture, command, ...args], options, callback);
}
