import { basename } from 'node:path';

const outputs = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.output', '.cache', '.venv', 'venv', '__pycache__', '.terraform', '.pulumi', '.wrangler', '.rer', '.seed', 'playwright-report', 'test-results']);
const tools = new Set(['.claude', '.codex', '.cursor', '.worktrees', '.idea', '.vscode', '.vscode-insiders', '.windsurf', '.continue', '.zed', '.aider', '.gemini', '.opencode']);

export const toolDirectory = path => path.split('/').some(part => tools.has(part.toLowerCase()));
export const gitDirectory = path => path.split('/').some(part => part.toLowerCase() === '.git');
export function skipped(path) {
 const part = path.split('/').find(part => outputs.has(part.toLowerCase()));
 return part ? part.toLowerCase() === '.git' ? 'gitDirectories' : 'generatedDirectories' : null;
}

const stores = new Set(['secrets', '.ssh', '.aws', '.gnupg', 'keychains', 'keychain', 'browser profiles', 'browser-profiles', '.mozilla', '.password-store', '.1password']);

function browserStore(path) {
 // Recognize browser data locations, rather than projects or arbitrary
 // directories named profiles, Firefox, Chromium or Safari.
 return /(?:^|\/)\.config\/(?:google-chrome(?:-[^/]+)?|chromium|brave-browser|bravesoftware\/brave-browser|microsoft-edge(?:-[^/]+)?)(?:\/|$)/.test(path) ||
  /(?:^|\/)library\/application support\/(?:google\/chrome(?: [^/]+)?|chromium|bravesoftware\/brave-browser|microsoft edge(?: [^/]+)?|firefox)(?:\/|$)/.test(path) ||
  /(?:^|\/)appdata\/(?:local\/(?:google\/chrome|chromium|bravesoftware\/brave-browser|microsoft\/edge)\/user data|roaming\/mozilla\/firefox)(?:\/|$)/.test(path) ||
  /(?:^|\/)library\/(?:safari|containers\/com\.apple\.safari|group containers\/[^/]*\.com\.apple\.safari)(?:\/|$)/.test(path);
}

function passwordExport(name) {
 return /^(?:1password|bitwarden|lastpass|dashlane|keeper|enpass|nordpass|keepass)(?:[._ -](?:exports?|backups?|credentials?|passwords?|logins?).*)?\.(?:csv|json|zip|txt|xml)$/.test(name) ||
  /^(?:password-manager|passwords?|vault|logins)[._ -](?:exports?|backups?)(?:[._ -].*)?\.(?:csv|json|zip|txt|xml)$/.test(name) ||
  /^(?:passwords?|logins)\.csv$/.test(name);
}

// Specific stores apply to absolute ancestors, including those of explicit
// roots. Filename rules apply only to the file, never to its parent projects.
// Denied directories are enumerated for metadata only, never file content.
export function denied(path) {
 const lower = path.toLowerCase(), name = basename(lower);
 return lower.split('/').some(part => stores.has(part) || /\.(?:opvault|agilekeychain)$/.test(part)) || browserStore(lower) ||
  /\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|kdb|1pux|1pif|opvault|agilekeychain)$/.test(name) ||
  /^id_/.test(name) || /^credentials/.test(name) || /^service-account.*\.json$/.test(name) ||
  /^\.env/.test(name) && !/\.(?:example|sample)$/.test(name) ||
  /^\.dev\.vars(?:$|\.)/.test(name) || /\.tfvars(?:\.json)?$/.test(name) || /kubeconfig/.test(name) || passwordExport(name);
}

export const example = path => /(?:^|[./_-])(?:examples?|samples?|templates?)(?:[./_-]|$)/i.test(path);

// Only recognised source/config formats are opened. Executable IaC is lexed,
// never imported, and arbitrary documents and binary files are left untouched.
export function readable(path) {
 const name = basename(path).toLowerCase();
 return /\.(?:jsonc?|ya?ml|toml|tf|hcl)(?:\.(?:example|sample|template|tpl))?$/.test(name) ||
  ['gemfile', 'go.mod', 'jenkinsfile'].includes(name) || /^requirements.*\.txt$/.test(name) ||
  example(path) && /(?:env|config|settings)/i.test(path) ||
  /(?:^|\/)(?:pulumi[^/]*|infra(?:structure)?)(?:\/|\.)/i.test(path) && /\.(?:[cm]?[jt]s|tsx|py|go|cs)$/.test(name);
}
