import { spawn } from 'node:child_process';

const service = 'com.runeditrun.business';
const unavailable = () => new Error('OS credential storage is unavailable or locked. Unlock macOS Keychain or install and unlock Linux Secret Service (secret-tool); otherwise use the wizard or Managed. No credential was written to a file.');

// All process output stays in memory. In particular, never attach a child error:
// OS tools may put credential material in their diagnostics.
function execute(command, args, input, env) {
 return new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], err = []; let size = 0, failed = false;
  const timer = setTimeout(() => { failed = true; child.kill(); }, 30000);
  const collect = list => chunk => { size += chunk.length; if (size > 262144) { failed = true; child.kill(); } else list.push(chunk); };
  child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
  child.stdin.on('error', () => {});
  child.on('error', () => { clearTimeout(timer); reject(unavailable()); });
  child.on('close', code => {
   clearTimeout(timer);
   if (failed || code === null) reject(unavailable());
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
 if (!['darwin', 'linux'].includes(platform)) throw unavailable();
 const call = async (...args) => { try { return await command(...args); } catch { throw unavailable(); } };
 const macArgs = handle => ['-s', service, '-a', handle];
 const linuxArgs = handle => ['application', service, 'handle', handle];
 async function get(handle) {
  checkedHandle(handle);
  const result = platform === 'darwin'
   ? await call('/usr/bin/security', ['find-generic-password', ...macArgs(handle), '-w'])
   : await call('secret-tool', ['lookup', ...linuxArgs(handle)]);
  if (platform === 'darwin' && result.code === 44 || platform === 'linux' && result.code === 1 && !result.stderr.trim()) return null;
  if (result.code !== 0) throw unavailable();
  return result.stdout.replace(/\r?\n$/, '');
 }
 return {
  get,
  async set(handle, secret) {
   checkedHandle(handle); checkedSecret(secret);
   if (platform === 'darwin') {
    // Interactive security receives the hex password on stdin. Hex also avoids
    // its command tokenizer interpreting quotes/backslashes in a vendor key.
    const hex = Buffer.from(secret, 'utf8').toString('hex');
    const result = await call('/usr/bin/security', ['-q', '-p', ''], `add-generic-password -U -s ${service} -a ${handle} -X ${hex}\n`);
    if (result.code !== 0 || result.stderr.trim()) throw unavailable();
   } else {
    const result = await call('secret-tool', ['store', '--label=Run Edit Run Business', ...linuxArgs(handle)], secret);
    if (result.code !== 0) throw unavailable();
   }
   // security's interactive exit status alone does not establish command success.
   if (await get(handle) !== secret) throw unavailable();
   return handle;
  },
  async delete(handle) {
   checkedHandle(handle);
   if (await get(handle) === null) return;
   const result = platform === 'darwin'
    ? await call('/usr/bin/security', ['delete-generic-password', ...macArgs(handle)])
    : await call('secret-tool', ['clear', ...linuxArgs(handle)]);
   if (result.code !== 0 && !(platform === 'darwin' && result.code === 44)) throw unavailable();
  },
 };
}

/** Interactive keys are never echoed. Piped input is accepted without printing
 * it, so a password manager can supply a key without a command-line argument.
 */
export async function readSecret({ input = process.stdin, output = process.stderr } = {}) {
 if (!input.isTTY) {
  let secret = '';
  for await (const chunk of input) {
   secret += chunk.toString('utf8');
   if (Buffer.byteLength(secret) > 65538) throw new Error('Credential input is too long.');
  }
  return checkedSecret(secret.replace(/\r?\n$/, ''));
 }
 if (typeof input.setRawMode !== 'function') throw new Error('A terminal with hidden input is required.');
 return new Promise((resolve, reject) => {
  let secret = '', done = false; const wasRaw = input.isRaw, wasPaused = input.isPaused();
  function finish(error) {
   if (done) return; done = true;
   input.off('data', data); input.off('end', ended); input.off('error', ended);
   process.off('SIGTERM', terminated); process.off('SIGINT', interrupted);
   input.setRawMode(Boolean(wasRaw)); if (wasPaused) input.pause(); output.write('\n');
   if (error) reject(error); else { try { resolve(checkedSecret(secret)); } catch (e) { reject(e); } }
  }
  const interrupted = () => finish(new Error('Credential entry cancelled.'));
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
  output.write('Credential (hidden): '); input.setRawMode(true);
  input.on('data', data); input.once('end', ended); input.once('error', ended);
  process.once('SIGTERM', terminated); process.once('SIGINT', interrupted); input.resume();
 });
}
