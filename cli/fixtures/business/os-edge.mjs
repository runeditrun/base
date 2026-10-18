// Test-only OS boundary. Production packages exclude fixture trees.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const [binary, ...args] = process.argv.slice(2), root = process.env.HOME;
if (!root?.includes('.business-connect-')) throw Error('Fixture requires an isolated test HOME');
const path = join(root, 'fake-keychain.json'), manager = join(root, 'fake-service');
async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
if (binary.endsWith('caffeinate')) { await new Promise(resolve => process.once('SIGTERM', resolve)); }
else if (binary.endsWith('launchctl') || binary === 'systemctl') {
 const command = args.find(item => ['print','bootstrap','bootout','enable','disable','is-active','daemon-reload'].includes(item));
 if (['print','is-active'].includes(command)) { process.exitCode = await exists(manager) ? 0 : 1; if (!process.exitCode) process.stdout.write('state = running\n'); }
 else if (['bootstrap','enable'].includes(command)) await writeFile(manager, 'running');
 else if (['bootout','disable'].includes(command)) await unlink(manager).catch(() => {});
} else {
 // No usable OS store: no Secret Service session, or a locked keychain.
 if (await exists(join(root, 'no-credential-store'))) { process.stderr.write('fixture: no OS credential store\n'); process.exit(1); }
 let values = {}; if (await exists(path)) values = JSON.parse(await readFile(path, 'utf8'));
 let handle, value, action;
 if (binary.endsWith('security')) {
  if (args[0] === '-q') {
   let input = ''; for await (const chunk of process.stdin) input += chunk;
   const parts = input.trim().split(' '); action = 'set'; handle = parts[parts.indexOf('-a') + 1]; value = Buffer.from(parts[parts.indexOf('-X') + 1], 'hex').toString();
  } else { action = args[0] === 'find-generic-password' ? 'get' : 'delete'; handle = args[args.indexOf('-a') + 1]; }
 } else {
  action = { lookup: 'get', store: 'set', clear: 'delete' }[args[0]]; handle = args[args.indexOf('handle') + 1];
  if (action === 'set') { value = ''; for await (const chunk of process.stdin) value += chunk; }
 }
 if (!handle || !action) throw Error('Invalid fake keychain operation');
 if (action === 'get') {
  if (Object.hasOwn(values, handle)) process.stdout.write(values[handle] + '\n'); else process.exitCode = binary.endsWith('security') ? 44 : 1;
 } else {
  if (action === 'set' && await exists(join(root, 'fail-credential-store'))) { process.exit(1); }
  // As macOS Keychain answers a write from inside an agent sandbox; reads still work.
  if (action === 'set' && await exists(join(root, 'sandboxed-credential-store'))) { process.stderr.write('security: SecKeychainItemCreateFromContent (<default>): UNIX[Operation not permitted]\n'); process.exit(1); }
  if (action === 'set') values[handle] = value; else delete values[handle];
  if (Object.keys(values).length) await writeFile(path, JSON.stringify(values), { mode: 0o600 }); else await unlink(path).catch(() => {});
 }
}
