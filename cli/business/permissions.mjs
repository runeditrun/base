import { mkdir, readFile, writeFile, unlink, rename, lstat, open, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const BUSINESS_DENY_RULES = Object.freeze([
 'Read(**/secrets/**)', 'Read(**/.ssh/**)', 'Read(**/.aws/**)', 'Read(**/.gnupg/**)',
 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)',
 'Read(**/*.p12)', 'Read(**/*.pfx)', 'Read(**/id_*)', 'Read(**/*.tfvars)',
 'Read(**/*kubeconfig*)', 'Read(**/credentials*)', 'Read(**/service-account*.json)',
 'Read(**/*.keychain*)', 'Read(**/keychains/**)', 'Read(**/Keychains/**)',
 'Read(**/Google/Chrome/**)', 'Read(**/Chromium/**)', 'Read(**/.mozilla/**)',
 'Read(**/*.1pux)', 'Read(**/*.1pif)', 'Read(**/*.kdbx)', 'Read(**/*.opvault/**)',
 'Read(**/.password-store/**)',
]);

const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function paths({ home = homedir(), stateDir = join(home, '.rer', 'business') } = {}) {
 if (!isAbsolute(home) || !isAbsolute(stateDir)) throw new Error('Business permission paths must be absolute.');
 return { settings: join(home, '.claude', 'settings.json'), receipt: join(stateDir, 'permissions.json'), stateDir };
}
async function readOptional(path) {
 try {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) throw new Error('Claude settings or Business permission receipt is not a supported regular file.');
  return await readFile(path, 'utf8');
 } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function atomic(path, text) {
 const temporary = `${path}.${randomUUID()}.tmp`;
 try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
 finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function parseSettings(text) {
 let value;
 try { value = text === null ? {} : JSON.parse(text); }
 catch { throw new Error('Claude user settings are invalid JSON; no permissions were changed.'); }
 if (!object(value) || value.permissions !== undefined && !object(value.permissions) || value.permissions?.deny !== undefined && (!Array.isArray(value.permissions.deny) || value.permissions.deny.some(rule => typeof rule !== 'string'))) throw new Error('Claude permissions.deny must be an array of strings; no permissions were changed.');
 return value;
}
async function lock(settings, work) {
 const path = `${settings}.rer-business.lock`, token = JSON.stringify({ pid: process.pid, id: randomUUID() });
 let handle;
 try { handle = await open(path, 'wx', 0o600); }
 catch (e) {
  if (e.code !== 'EEXIST') throw e;
  let holder;
  try { holder = JSON.parse(await readOptional(path)); } catch { throw new Error('Claude settings have a permission-change lock; check it before retrying.'); }
  if (!Number.isSafeInteger(holder?.pid) || holder.pid <= 0) throw new Error('Claude settings have an invalid permission-change lock.');
  try { process.kill(holder.pid, 0); } catch (error) {
   if (error.code === 'ESRCH') { await unlink(path); return lock(settings, work); }
  }
  throw new Error('Another process is changing Claude permissions; retry when it finishes.');
 }
 try { await handle.writeFile(token); await handle.close(); return await work(); }
 finally { await handle.close().catch(() => {}); if (await readOptional(path) === token) await unlink(path); }
}
async function replaceSettings(path, before, after) {
 const temporary = `${path}.${randomUUID()}.tmp`;
 try {
  if (after !== null) await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
  // Do not replace a snapshot if another rer invocation or editor changed it
  // while the new document/receipt was being prepared.
  if (await readOptional(path) !== before) throw new Error('Claude settings changed concurrently; no replacement was made. Retry the permission change.');
  if (after === null) await unlink(path); else await rename(temporary, path);
 } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function receiptFrom(text, settings) {
 let receipt;
 try { receipt = JSON.parse(text); } catch { throw new Error('Business permission receipt is invalid; Claude settings were left intact.'); }
 if (!object(receipt) || receipt.version !== 1 || receipt.settings !== settings || !Array.isArray(receipt.added) || receipt.added.some(rule => !BUSINESS_DENY_RULES.includes(rule)) || !['prepared', 'active'].includes(receipt.phase)) throw new Error('Business permission receipt is invalid; Claude settings were left intact.');
 return receipt;
}
async function recover(p, receipt, current) {
 if (receipt.phase !== 'prepared') return receipt;
 if (hash(current) === receipt.afterHash) {
  receipt.phase = 'active'; await atomic(p.receipt, JSON.stringify(receipt) + '\n'); return receipt;
 }
 if (hash(current) === receipt.beforeHash) { await unlink(p.receipt); return null; }
 throw new Error('Claude settings changed during an interrupted permission installation. Keep the settings intact and resolve the Business permission receipt before retrying.');
}

/** Explicit opt-in only. The receipt records introduced rules, never a copy of
 * settings (which can contain unrelated credentials or private configuration).
 */
export async function installPermissions(input = {}) {
 if (input.consent !== true) throw new Error('Changing Claude user permissions requires explicit consent.');
 const p = paths(input);
 let createdDirectory = false;
 try { await lstat(dirname(p.settings)); } catch (e) { if (e.code !== 'ENOENT') throw e; createdDirectory = true; }
 await mkdir(dirname(p.settings), { recursive: true, mode: 0o700 });
 await mkdir(p.stateDir, { recursive: true, mode: 0o700 });
 return lock(p.settings, async () => {
  const before = await readOptional(p.settings), old = await readOptional(p.receipt);
  if (old !== null) {
   const receipt = await recover(p, receiptFrom(old, p.settings), before);
   if (receipt) return { installed: true, added: receipt.added.length };
  }
  const settings = parseSettings(before), existing = settings.permissions?.deny ?? [];
  const added = BUSINESS_DENY_RULES.filter(rule => !existing.includes(rule));
  if (!added.length) return { installed: false, added: 0 };
  const receipt = { version: 1, settings: p.settings, phase: 'prepared', added, createdDirectory,
   createdSettings: before === null, createdPermissions: settings.permissions === undefined,
   createdDeny: settings.permissions?.deny === undefined, beforeHash: hash(before) };
  settings.permissions ??= {}; settings.permissions.deny = [...existing, ...added];
  const after = JSON.stringify(settings, null, 2) + '\n'; receipt.afterHash = hash(after);
  await atomic(p.receipt, JSON.stringify(receipt) + '\n');
  await replaceSettings(p.settings, before, after);
  receipt.phase = 'active'; await atomic(p.receipt, JSON.stringify(receipt) + '\n');
  return { installed: true, added: added.length };
 });
}

/** Re-read current settings and subtract only our additions; preserve all
 * preexisting rules and unrelated edits rather than restoring an old document.
 */
export async function removePermissions(input = {}) {
 const p = paths(input);
 if (await readOptional(p.receipt) === null) return { removed: false };
 const originalReceipt = receiptFrom(await readOptional(p.receipt), p.settings);
 await mkdir(dirname(p.settings), { recursive: true, mode: 0o700 });
 const result = await lock(p.settings, async () => {
  const raw = await readOptional(p.receipt);
  if (raw === null) return { removed: false };
  const before = await readOptional(p.settings), receipt = await recover(p, receiptFrom(raw, p.settings), before);
  if (!receipt) return { removed: false };
  if (before !== null) {
   const settings = parseSettings(before), rules = settings.permissions?.deny;
   if (rules) {
    for (const rule of receipt.added) { const index = rules.indexOf(rule); if (index >= 0) rules.splice(index, 1); }
    if (receipt.createdDeny && !rules.length) delete settings.permissions.deny;
    if (receipt.createdPermissions && !Object.keys(settings.permissions).length) delete settings.permissions;
   }
   const after = receipt.createdSettings && !Object.keys(settings).length ? null : JSON.stringify(settings, null, 2) + '\n';
   await replaceSettings(p.settings, before, after);
  }
  await unlink(p.receipt);
  return { removed: true };
 });
 if (originalReceipt.createdDirectory) await rmdir(dirname(p.settings)).catch(e => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; });
 return result;
}
