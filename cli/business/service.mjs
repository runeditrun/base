import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink, realpath, stat, lstat, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { stateDirectory } from './state.mjs';

const label = 'com.runeditrun.business', unit = 'rer-business.service';
const digest = text => createHash('sha256').update(text).digest('hex');
const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const unitValue = value => `"${String(value).replace(/[%\\"\n\r\t]/g, char => ({ '%': '%%', '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[char])}"`;

function execute(binary, args) {
 return new Promise(resolve => execFile(binary, args, { timeout: 30000, maxBuffer: 65536 }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout ?? '' })));
}
function options(input = {}) {
 const home = input.home ?? homedir(), platform = input.platform ?? process.platform;
 if (!isAbsolute(home) || !['darwin', 'linux'].includes(platform)) throw new Error('Business background services require macOS or Linux and an absolute home directory.');
 const stateDir = input.stateDir ?? (input.home === undefined ? stateDirectory() : join(home, '.rer', 'business'));
 if (!isAbsolute(stateDir)) throw new Error('Business service state directory must be absolute.');
 return { ...input, home, platform, stateDir, run: input.run ?? execute };
}
function servicePath({ home, platform }) {
 return platform === 'darwin' ? join(home, 'Library', 'LaunchAgents', `${label}.plist`) : join(home, '.config', 'systemd', 'user', unit);
}
async function readOptional(path) {
 try {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Business service path is not a regular file.');
  return await readFile(path, 'utf8');
 } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function atomic(path, text) {
 const temporary = `${path}.${randomUUID()}.tmp`;
 try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
 finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function checkedRun(run, binary, args, operation) {
 let result;
 try { result = await run(binary, args); } catch { throw new Error(`Could not ${operation} the Business background service.`); }
 if (result.code !== 0) throw new Error(`Could not ${operation} the Business background service. Check your user service manager and retry.`);
}
async function missingParents(directory, home) {
 const missing = [];
 for (let path = directory; path !== home && path !== dirname(path); path = dirname(path)) {
  try { await lstat(path); break; } catch (e) { if (e.code !== 'ENOENT') throw e; missing.push(path); }
 }
 return missing;
}
async function removeEmpty(paths) {
 for (const path of [...new Set(paths)].sort((a, b) => b.length - a.length)) await rmdir(path).catch(e => {
  if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e;
 });
}

/** Call only after specific service-install consent. No credentials are placed
 * in the unit, process arguments, environment, or service receipt.
 */
export async function installService(input = {}) {
 if (input.consent !== true) throw new Error('Installing the Business background service requires explicit consent.');
 const o = options(input), path = servicePath(o), receiptPath = join(o.stateDir, 'service.json');
 const node = await realpath(input.nodePath ?? process.execPath);
 const entrypoint = await realpath(input.entrypoint ?? fileURLToPath(new URL('../../bin/rer.mjs', import.meta.url)));
 if (!isAbsolute(node) || !isAbsolute(entrypoint) || !(await stat(node)).isFile() || !(await stat(entrypoint)).isFile()) throw new Error('Business requires an absolute Node executable and rer entrypoint.');
 const log = join(o.stateDir, 'service.log'), errorLog = join(o.stateDir, 'service-error.log');
 const environmentPath = `${dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
 // A state folder chosen with RER_BUSINESS_STATE_DIR goes with the service.
 const environment = [['HOME', o.home], ['PATH', environmentPath], ...(o.stateDir !== join(o.home, '.rer', 'business') ? [['RER_BUSINESS_STATE_DIR', o.stateDir]] : [])];
 const text = o.platform === 'darwin'
  ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${[node, entrypoint, 'business', 'run'].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict>${environment.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>\n<key>WorkingDirectory</key><string>${xml(o.home)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer><key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(errorLog)}</string>\n</dict></plist>\n`
  : `[Unit]\nDescription=Run Edit Run Business executor\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${[node, entrypoint, 'business', 'run'].map(value => unitValue(value).replaceAll('$', () => '$$')).join(' ')}\nWorkingDirectory=${unitValue(o.home)}\nEnvironment=${environment.map(([key, value]) => unitValue(`${key}=${value}`)).join(' ')}\nRestart=on-failure\nRestartSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
 const existing = await readOptional(path), oldReceipt = await readOptional(receiptPath);
 if (existing !== null && (!oldReceipt || JSON.parse(oldReceipt).hash !== digest(existing))) throw new Error('A background service already exists at the Business service path; it was not overwritten.');
 if (oldReceipt && existing !== null && existing !== text) throw new Error('Remove the existing Business service before changing its installation paths.');
 const createdDirectories = oldReceipt ? JSON.parse(oldReceipt).createdDirectories ?? [] : [...await missingParents(dirname(path), o.home), ...await missingParents(o.stateDir, o.home)];
 await mkdir(o.stateDir, { recursive: true, mode: 0o700 });
 await mkdir(dirname(path), { recursive: true, mode: 0o700 });
 // Write ownership before installation so an interrupted install is removable.
 await atomic(receiptPath, JSON.stringify({ version: 1, platform: o.platform, path, hash: digest(text), createdDirectories }) + '\n');
 if (existing === null) await writeFile(path, text, { flag: 'wx', mode: 0o600 });
 if (o.platform === 'darwin') {
  const target = `gui/${process.getuid()}`;
  // A repeated connect can reuse the already-loaded, exactly-owned service.
  const loaded = await o.run('/bin/launchctl', ['print', `${target}/${label}`]);
  if (loaded.code !== 0) await checkedRun(o.run, '/bin/launchctl', ['bootstrap', target, path], 'start');
 } else {
  await checkedRun(o.run, 'systemctl', ['--user', 'daemon-reload'], 'reload');
  await checkedRun(o.run, 'systemctl', ['--user', 'enable', '--now', unit], 'start');
 }
 return { installed: true, platform: o.platform, path };
}

/** Removes only receipt-bound files. An edited/replaced unit is left for the
 * owner instead of unlinking somebody else's service.
 */
export async function removeService(input = {}) {
 const o = options(input), receiptPath = join(o.stateDir, 'service.json');
 const raw = await readOptional(receiptPath);
 if (raw === null) return { removed: false };
 const receipt = JSON.parse(raw), path = servicePath(o), existing = await readOptional(path);
 if (receipt.version !== 1 || receipt.platform !== o.platform || receipt.path !== path || existing !== null && digest(existing) !== receipt.hash) throw new Error('The Business service file changed outside rer; it was left intact.');
 if (o.platform === 'darwin') {
  const target = `gui/${process.getuid()}/${label}`;
  const loaded = await o.run('/bin/launchctl', ['print', target]);
  if (loaded.code === 0) await checkedRun(o.run, '/bin/launchctl', ['bootout', target], 'stop');
 } else {
  await checkedRun(o.run, 'systemctl', ['--user', 'disable', '--now', unit], 'stop');
 }
 if (existing !== null) {
  if (await readOptional(path) !== existing) throw new Error('The Business service changed while disconnecting; retry after checking it.');
  await unlink(path);
 }
 if (o.platform === 'linux') await checkedRun(o.run, 'systemctl', ['--user', 'daemon-reload'], 'reload');
 for (const name of ['service.log', 'service-error.log', 'service.json']) await unlink(join(o.stateDir, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
 const allowedDirectories = new Set();
 for (const start of [dirname(path), o.stateDir]) for (let dir = start; dir !== o.home && dir !== dirname(dir); dir = dirname(dir)) allowedDirectories.add(dir);
 await removeEmpty((receipt.createdDirectories ?? []).filter(dir => allowedDirectories.has(dir)));
 return { removed: true };
}

export async function serviceStatus(input = {}) {
 const o = options(input), raw = await readOptional(join(o.stateDir, 'service.json'));
 if (raw === null) return { installed: false, running: false };
 const receipt = JSON.parse(raw), path = servicePath(o), existing = await readOptional(path);
 if (receipt.version !== 1 || receipt.path !== path || receipt.platform !== o.platform || existing !== null && digest(existing) !== receipt.hash) throw new Error('The Business service file changed outside rer.');
 if (existing === null) return { installed: false, running: false };
 const result = o.platform === 'darwin'
  ? await o.run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`])
  : await o.run('systemctl', ['--user', 'is-active', '--quiet', unit]);
 return { installed: true, running: result.code === 0 && (o.platform !== 'darwin' || /(?:^|\n)\s*state = running\s*(?:\n|$)/.test(result.stdout ?? '')) };
}

/** The caller holds an export lease only within this callback. -w also makes
 * caffeinate stop if the executor is killed before its finally block runs.
 */
export async function withExportAwake(work, { consent = false, platform = process.platform, signal } = {}) {
 if (platform !== 'darwin') return work();
 if (consent !== true) throw new Error('Keeping this Mac awake for an export requires explicit consent.');
 signal?.throwIfAborted();
 const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
 const closed = new Promise(resolve => child.once('close', resolve));
 const stop = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
 const onExit = () => stop();
 try {
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Could not keep this Mac awake for the export.'))); });
  signal?.addEventListener('abort', stop, { once: true }); process.once('exit', onExit);
  signal?.throwIfAborted();
  return await work();
 } finally {
  signal?.removeEventListener('abort', stop); process.off('exit', onExit);
  stop();
  if (child.pid) await closed;
 }
}
