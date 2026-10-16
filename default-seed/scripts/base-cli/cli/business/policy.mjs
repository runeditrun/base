import { basename } from 'node:path';

const outputs = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.output', '.cache', '.venv', 'venv', '__pycache__', '.terraform', '.pulumi', '.wrangler', '.rer', '.seed', 'playwright-report', 'test-results']);

export const skipped = path => path.split('/').some(part => outputs.has(part.toLowerCase()));

// Applies to every ancestor, including ancestors of an explicitly supplied root.
// Directories on this list are enumerated for metadata only, never file content.
export function denied(path) {
 const parts = path.toLowerCase().split('/');
 return parts.some(part => ['secrets', '.ssh', '.aws', '.gnupg', 'keychains', 'keychain', 'browser profiles', 'browser-profiles', 'profiles', '.mozilla', '.password-store'].includes(part) ||
  /\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|kdb|1pux|1pif|opvault|agilekeychain)$/.test(part) ||
  /^id_/.test(part) || /^credentials/.test(part) || /^service-account.*\.json$/.test(part) ||
  /^\.env/.test(part) && !/\.(?:example|sample)$/.test(part) ||
  /^\.dev\.vars(?:$|\.)/.test(part) || /\.tfvars(?:\.json)?$/.test(part) || /kubeconfig/.test(part) ||
  /^(?:passwords?|vault|logins)(?:[._ -]|$)/.test(part) || /(?:1password|bitwarden|lastpass|dashlane|keeper|enpass|nordpass|keepass)/.test(part)) ||
  /(?:^|\/)(?:google\/chrome|google-chrome|chromium|brave-browser|bravesoftware|microsoft edge|firefox|safari)(?:\/|$)/.test(path.toLowerCase());
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
