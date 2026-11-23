import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { saveJson, stateDirectory } from './state.mjs';

const refreshBefore = 60_000;

async function readCachedToken(path) {
 let file;
 try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
 catch (error) {
  if (['ENOENT', 'ELOOP'].includes(error.code)) return null;
  throw error;
 }
 try {
  const info = await file.stat();
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) return null;
  const text = await file.readFile('utf8');
  let token;
  try { token = JSON.parse(text); } catch { return null; }
  if (typeof token?.expires_at !== 'string' || typeof token.access_token !== 'string') return null;
  return /^bz_task_[A-Za-z0-9_-]+$/.test(token.access_token) ? token : null;
 } finally { await file.close(); }
}

export function mcpTokenCache(api, state, taskId) {
 // Including the device credential also fences key rotation and legacy pairings.
 const key = createHash('sha256').update(JSON.stringify([api.origin, state.businessId, state.executorId, api.credential, taskId ?? null])).digest('hex');
 const name = 'mcp-token-' + key + '.json', path = join(stateDirectory(), name);
 let loading;
 return {
  get(signal) {
   signal?.throwIfAborted();
   loading ??= (async () => {
    const cached = await readCachedToken(path);
    if (Date.parse(cached?.expires_at) - Date.now() > refreshBefore) return cached.access_token;
    const { access_token, expires_at } = await api.mintToken('mcp', { taskId, signal });
    await saveJson(name, { access_token, expires_at });
    return access_token;
   })().finally(() => { loading = undefined; });
   return loading;
  },
  async drop(refused) {
   // Another invocation may already have replaced the refused bearer.
   if ((await readCachedToken(path))?.access_token === refused) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  },
 };
}
