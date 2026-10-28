import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const service = 'com.runeditrun.business';
const sandboxed = 'an agent sandbox blocks this. Run this one command outside the sandbox (in Codex, approve running it outside the sandbox when it asks), or in your own terminal';
// Inside a Codex workspace-write sandbox with network on, security answers 161
// for a write or a removal (UNIX Operation not permitted), even after printing
// "password has been deleted."; the item stays in the keychain.
const refusedBySandbox = result => /Operation not permitted|Unable to obtain authorization/.test(result?.stderr ?? '') || result?.code === 161;
// Causes come from fixed phrases matched in the tool's diagnostics; the
// diagnostics themselves are never printed.
function cause(binary, result) {
 const text = result?.stderr ?? '';
 if (result?.spawnFailed) return binary === 'secret-tool' ? 'secret-tool is not installed. Install it and unlock a Secret Service session' : `${binary} could not start`;
 if (/Operation not permitted/.test(text)) return `macOS Keychain refused the write (Operation not permitted); ${sandboxed}`;
 if (result?.code === 161) return `macOS Keychain refused the change (security exited with status 161: Operation not permitted); ${sandboxed}`;
 if (/Unable to obtain authorization/.test(text)) return `macOS Keychain refused authorization; ${sandboxed}`;
 if (/User interaction is not allowed|interaction is not allowed/i.test(text)) return 'the keychain is locked and cannot ask for its password here. Unlock it, then try again';
 if (/autolaunch D-Bus|Cannot spawn a message bus|org\.freedesktop\.secrets/.test(text)) return 'no unlocked Secret Service session is running. Unlock one, then try again';
 if (result?.timedOut) return `${binary} did not answer within 30 seconds`;
 return `${binary} exited with status ${result?.code ?? 'unknown'}. Unlock macOS Keychain, or install and unlock Linux Secret Service (secret-tool), then try again`;
}
const unavailable = (operation, binary, result) => {
 const error = new Error(`OS credential storage could not ${operation} a credential: ${cause(binary, result)}. No credential was written to a file.`);
 error.sandboxRefused = refusedBySandbox(result); error.osStatus = result?.code ?? null;
 return error;
};

// All process output stays in memory. In particular, never attach a child error:
// OS tools may put credential material in their diagnostics.
function execute(command, args, input, env) {
 return new Promise(resolve => {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], err = []; let size = 0, failed = false;
  const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 30000);
  const collect = list => chunk => { size += chunk.length; if (size > 262144) { failed = true; child.kill('SIGKILL'); } else list.push(chunk); };
  child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
  child.stdin.on('error', () => {});
  child.on('error', () => { clearTimeout(timer); resolve({ code: null, spawnFailed: true, stdout: '', stderr: '' }); });
  child.on('close', code => {
   clearTimeout(timer);
   if (failed || code === null) resolve({ code: null, timedOut: true, stdout: '', stderr: Buffer.concat(err).toString('utf8') });
   else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
  });
  child.stdin.end(input);
 });
}

function checkedHandle(handle) {
 if (typeof handle !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,253}$/.test(handle)) throw new Error('Invalid credential handle.');
 return handle;
}

function checkedSecret(secret) {
 if (typeof secret !== 'string' || !secret.length || Buffer.byteLength(secret) > 65536 || /[\x00-\x1f\x7f]/.test(secret)) throw new Error('Enter a nonempty, single-line credential.');
 return secret;
}

/** Secrets cross only stdin/stdout pipes, never arguments, files, or exceptions.
 * run is a process-edge seam for tests, not a selectable storage backend.
 */
export function createCredentialStore({ platform = process.platform, env = process.env, run } = {}) {
 const command = run ?? ((binary, args, input) => execute(binary, args, input, env));
 if (!['darwin', 'linux'].includes(platform)) throw new Error('OS credential storage is available only on macOS (Keychain) and Linux (Secret Service). No credential was written to a file.');
 const binary = platform === 'darwin' ? 'security' : 'secret-tool';
 const call = async (operation, ...args) => {
  let result;
  try { result = await command(...args); } catch { throw unavailable(operation, binary, { spawnFailed: true }); }
  if (result.spawnFailed || result.timedOut) throw unavailable(operation, binary, result);
  return result;
 };
 const macArgs = handle => ['-s', service, '-a', handle];
 const linuxArgs = handle => ['application', service, 'handle', handle];
 async function get(handle) {
  checkedHandle(handle);
  const result = platform === 'darwin'
   ? await call('read', '/usr/bin/security', ['find-generic-password', ...macArgs(handle), '-w'])
   : await call('read', 'secret-tool', ['lookup', ...linuxArgs(handle)]);
  if (platform === 'darwin' && result.code === 44 || platform === 'linux' && result.code === 1 && !result.stderr.trim()) return null;
  if (result.code !== 0) throw unavailable('read', binary, result);
  return result.stdout.replace(/\r?\n$/, '');
 }
 return {
  get,
  /** Write and remove a throwaway item, so a store that reads but refuses
   * writes (an agent sandbox) is found before anything is redeemed. */
  async check() {
   const handle = `probe:${randomUUID()}`;
   await this.set(handle, randomUUID());
   await this.delete(handle);
  },
  async set(handle, secret) {
   checkedHandle(handle); checkedSecret(secret);
   if (platform === 'darwin') {
    // Interactive security receives the hex password on stdin. Hex also avoids
    // its command tokenizer interpreting quotes/backslashes in a vendor key.
    const hex = Buffer.from(secret, 'utf8').toString('hex');
    const result = await call('save', '/usr/bin/security', ['-q', '-p', ''], `add-generic-password -U -s ${service} -a ${handle} -X ${hex}\n`);
    if (result.code !== 0 || result.stderr.trim()) throw unavailable('save', binary, result);
   } else {
    const result = await call('save', 'secret-tool', ['store', '--label=Run Edit Run Business', ...linuxArgs(handle)], secret);
    if (result.code !== 0) throw unavailable('save', binary, result);
   }
   // security's interactive exit status alone does not establish command success.
   if (await get(handle) !== secret) throw unavailable('save', binary, { code: 0, stderr: '' });
   return handle;
  },
  async delete(handle) {
   checkedHandle(handle);
   if (await get(handle) === null) return;
   const result = platform === 'darwin'
    ? await call('remove', '/usr/bin/security', ['delete-generic-password', ...macArgs(handle)])
    : await call('remove', 'secret-tool', ['clear', ...linuxArgs(handle)]);
   if (result.code !== 0 && !(platform === 'darwin' && result.code === 44)) throw unavailable('remove', binary, result);
   // A refused removal can still print success; only a read-back proves it.
   if (await get(handle) !== null) throw unavailable('remove', binary, { code: result.code, stderr: '' });
  },
 };
}

/** Credentials require a terminal that can hide input; keys are never echoed. */
export async function readSecret({ input = process.stdin, output = process.stderr } = {}) {
 if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('A terminal with hidden input is required.');
 return new Promise((resolve, reject) => {
  let secret = '', done = false; const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
  function finish(error) {
   if (done) return; done = true;
   input.off('data', data); input.off('end', ended); input.off('error', ended);
   process.off('SIGTERM', terminated); process.off('SIGINT', interrupted);
   // A fresh stdin has readableFlowing === null, but isPaused() is false.
   // Stop the read we started so the terminal does not keep the command alive.
   input.setRawMode(Boolean(wasRaw)); if (!wasFlowing) input.pause(); output.write('\n');
   if (error) reject(error); else { try { resolve(checkedSecret(secret)); } catch (e) { reject(e); } }
  }
  const interrupted = () => finish(new Error('Credential entry canceled.'));
  const terminated = () => finish(new Error('Credential entry interrupted.'));
  const ended = () => finish(new Error('Credential input ended before confirmation.'));
  function data(chunk) {
   for (const character of chunk.toString('utf8')) {
    if (character === '\x03' || character === '\x04') { interrupted(); return; }
    if (character === '\r' || character === '\n') { finish(); return; }
    if (character === '\x7f' || character === '\b') secret = Array.from(secret).slice(0, -1).join('');
    else if (!/[\x00-\x1f]/.test(character)) secret += character;
    if (Buffer.byteLength(secret) > 65536) { finish(new Error('Credential input is too long.')); return; }
   }
  }
  input.setRawMode(true); output.write('Credential (hidden): ');
  input.on('data', data); input.once('end', ended); input.once('error', ended);
  process.once('SIGTERM', terminated); process.once('SIGINT', interrupted); input.resume();
 });
}
