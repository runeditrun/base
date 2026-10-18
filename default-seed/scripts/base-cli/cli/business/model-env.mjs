import { constants } from 'node:fs';
import { access, lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Transport settings every model CLI may need. Never the supervisor's Node
// preload, agent instructions, hooks or MCP configuration.
const transport = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
// Each CLI receives only its own vendor's credentials.
const credentials = { claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'] };
const pick = keys => Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

// Help, feature and catalog probes run in a throwaway home with no credentials.
export const detectionEnvironment = home => ({ ...pick(transport), HOME: home, CODEX_HOME: join(home, 'codex') });

// Per-turn limits Claude Code enforces itself: 1024 output tokens, no thinking.
export const claudeLimits = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024', CLAUDE_CODE_DISABLE_THINKING: '1' };

// Claude Code on macOS finds its keychain login through the user name.
export function claudeEnvironment() {
 const user = () => userInfo().username;
 return { ...pick(transport), HOME: process.env.HOME ?? homedir(), USER: process.env.USER || user(), LOGNAME: process.env.LOGNAME || user(), ...pick(credentials.claude), ...claudeLimits };
}

// Codex runs with a private home and CODEX_HOME holding only copied auth.
export const codexEnvironment = (home, codexHome) => ({ ...pick(transport), HOME: home, CODEX_HOME: codexHome, ...pick(credentials.codex) });

// Someone who can write a folder above the CLI could swap it. Every link and
// file must belong to this user or root, and every folder too, writable by
// group or others only when it is root's sticky folder (such as /tmp).
const owned = info => info.uid === process.getuid() || info.uid === 0;
const safeFolder = info => info.isDirectory() && owned(info) && ((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0 && info.uid === 0);
function ancestors(path) {
 const folders = [];
 for (let folder = dirname(path); ; folder = dirname(folder)) { folders.push(folder); if (folder === dirname(folder)) return folders; }
}
// The folders above one name, as written (symbolic links checked by owner,
// since their mode means nothing) and as resolved.
async function safeFolders(path) {
 for (const folder of ancestors(path)) {
  const info = await lstat(folder);
  if (info.isSymbolicLink() ? !owned(info) : !safeFolder(info)) return false;
 }
 const real = await realpath(dirname(path));
 for (const folder of [real, ...ancestors(real)]) if (!safeFolder(await stat(folder))) return false;
 return true;
}

// Follows each link from the PATH entry to an executable regular file that
// neither group nor others can modify, checking every step. Returns the
// resolved path, which is what runs, or null.
export async function trustedExecutable(path) {
 try {
  if (!isAbsolute(path)) return null;
  for (let current = path, hop = 0; hop < 40; hop++) {
   const info = await lstat(current);
   if (!owned(info) || !(await safeFolders(current))) return null;
   if (info.isSymbolicLink()) { current = resolve(dirname(current), await readlink(current)); continue; }
   if (!info.isFile() || (info.mode & 0o022) !== 0) return null;
   await access(current, constants.X_OK);
   return await realpath(current);
  }
  return null;
 } catch { return null; }
}
