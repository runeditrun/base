import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

// Transport settings every model CLI may need. Never the supervisor's Node
// preload, agent instructions, hooks or MCP configuration.
const transport = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
// Each CLI receives only its own vendor's credentials.
const credentials = { claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'] };
const pick = keys => Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

// Help, feature and catalog probes run in a throwaway home with no credentials.
export const detectionEnvironment = home => ({ ...pick(transport), HOME: home, CODEX_HOME: join(home, 'codex') });

// Claude Code on macOS finds its keychain login through the user name.
export function claudeEnvironment() {
 const user = () => userInfo().username;
 return { ...pick(transport), HOME: process.env.HOME ?? homedir(), USER: process.env.USER || user(), LOGNAME: process.env.LOGNAME || user(), ...pick(credentials.claude) };
}

// Codex runs with a private home and CODEX_HOME holding only copied auth.
export const codexEnvironment = (home, codexHome) => ({ ...pick(transport), HOME: home, CODEX_HOME: codexHome, ...pick(credentials.codex) });

// Only an executable regular file that neither group nor others can modify.
// Returns its resolved path, or null.
export async function trustedExecutable(path) {
 try {
  const real = await realpath(path), info = await stat(real);
  if (!info.isFile() || (info.mode & 0o022) !== 0) return null;
  await access(real, constants.X_OK);
  return real;
 } catch { return null; }
}
