import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const userCodexHome = () => isAbsolute(process.env.CODEX_HOME ?? '') ? process.env.CODEX_HOME : join(homedir(), '.codex');
const uncopyable = () => Error('Business classifier could not copy Codex credentials. Sign Codex in with file-stored credentials or set OPENAI_API_KEY. Task released.');

async function authFile(path) {
 const info = await stat(path);
 if (!info.isFile() || info.size > 65536) throw uncopyable();
 const bytes = await readFile(path);
 try { if (object(JSON.parse(bytes.toString('utf8')))) return bytes; } catch { /* Refused below. */ }
 throw uncopyable();
}

// Copy only the customer's Codex auth file into the private CODEX_HOME. Their
// config, MCP servers, hooks, rules, skills and global AGENTS.md stay behind.
// Without a copyable file, only an OpenAI API key in the environment works.
export async function copyCodexCredentials(codexHome) {
 const source = join(userCodexHome(), 'auth.json');
 let bytes;
 try { bytes = await authFile(source); }
 catch (error) {
  if (error.code === 'ENOENT' && (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)) return null;
  throw uncopyable();
 }
 await writeFile(join(codexHome, 'auth.json'), bytes, { mode: 0o600, flag: 'wx' });
 return { source, bytes };
}

// Codex rotates ChatGPT refresh tokens when it refreshes them. Return a
// refreshed copy to the customer's file, unless their own Codex changed it.
export async function returnRefreshedCredentials(copy, codexHome) {
 if (!copy) return;
 const refreshed = await authFile(join(codexHome, 'auth.json')).catch(() => null);
 if (!refreshed || refreshed.equals(copy.bytes)) return;
 if (!(await readFile(copy.source)).equals(copy.bytes)) return;
 const temporary = join(dirname(copy.source), `.auth.json.${randomUUID()}.tmp`);
 try {
  await writeFile(temporary, refreshed, { mode: 0o600, flag: 'wx' });
  await rename(temporary, copy.source);
 } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// The smallest current model in the catalog the installed Codex ships with.
const tiers = ['nano', 'mini', 'luna', 'terra', 'sol', 'astra'];
export function smallestCodexModel(output) {
 let catalog;
 try { catalog = JSON.parse(output); } catch { return null; }
 const ranked = (Array.isArray(catalog?.models) ? catalog.models : [])
  .filter(model => object(model) && typeof model.slug === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(model.slug) && model.visibility === 'list' && !model.upgrade)
  .map(model => ({ slug: model.slug, tier: tiers.findIndex(tier => model.slug.split(/[.-]/).includes(tier)), priority: Number.isFinite(model.priority) ? model.priority : Infinity }))
  .filter(model => model.tier >= 0)
  .sort((a, b) => a.tier - b.tier || a.priority - b.priority);
 return ranked[0]?.slug ?? null;
}

// Render the model-visible input Codex would send and refuse if anything but
// Codex's own developer text and the probe would reach the model, such as an
// AGENTS.md or AGENTS.override.md.
export const instructionProbe = 'rer-business-instruction-probe';
export function onlyProbe(output) {
 let items;
 try { items = JSON.parse(output); } catch { return false; }
 if (!Array.isArray(items) || !items.every(item => object(item) && ['developer', 'user'].includes(item.role))) return false;
 const users = items.filter(item => item.role === 'user');
 return users.length === 1 && items.at(-1) === users[0] && JSON.stringify(users[0].content) === JSON.stringify([{ type: 'input_text', text: instructionProbe }]);
}
