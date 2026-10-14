// A dependency install runs code the seed did not write: the package manager
// and every build script it allows (esbuild, workerd, sharp, oxide). It gets
// only the variables an install needs, named below; every other variable,
// whatever it is called, stays with the caller. The seed's own commands that
// need credentials, such as deploy, still receive the whole environment.
import { applicationBindings } from './local/environment.mjs';
import { credentialName, credentialValue } from './redaction.mjs';

// The shell, locale, terminal and temporary folders, Node's own settings, and
// the SSH agent a git+ssh dependency is fetched through. Kept whatever their
// value looks like: a directory may resemble a token.
const system = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|LANG|LANGUAGE|LC_[A-Z]+|TZ|CI|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|XDG_[A-Z_]+)$/;
// The install reaches its registry through these; any user:password is dropped.
const proxy = /^(https?_proxy|all_proxy|no_proxy)$/i;
// Package manager settings and rer's control variables, except credentials.
const settings = /^(npm_config_|PNPM_|COREPACK_|RER_)/i;
// Credential words inside a name, also run together: NPM_CONFIG__AUTHTOKEN,
// PNPM_REGISTRY_PASSWORD, RER_PREVIEW_TOKEN, RER_SIGNING_KEY.
const credentialPart = /TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|CREDENTIAL|CREDS|JWT|COOKIE|WEBHOOK|SESSION|AUTH(?!OR)|(API|ACCESS|PRIVATE|SIGNING|ENCRYPTION|MASTER|LICENSE)_?KEY/i;

// Up to the last @ of the authority, whatever the password holds (spaces included), after any leading whitespace.
const withoutUserinfo = value => value.replace(/^\s*([a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i, '$1');

export function dependencyEnvironment(env = process.env) {
 const kept = {};
 for (const [key, value] of Object.entries(env)) {
  if (value === undefined) continue;
  if (system.test(key)) kept[key] = value;
  else if (proxy.test(key)) kept[key] = withoutUserinfo(value);
  else if (settings.test(key) && !(credentialName(key) || credentialPart.test(key) || applicationBindings.test(key) || credentialValue(value))) kept[key] = value;
 }
 return kept;
}
