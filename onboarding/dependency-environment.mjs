// A dependency install runs code the seed did not write: the package manager
// and every build script it allows (esbuild, workerd, sharp, oxide). It gets
// the caller's environment without provider credentials, application bindings
// or any variable whose name or value marks a credential. The seed's own
// commands that need them, such as deploy, still receive them.
import { applicationBindings } from './local/environment.mjs';
import { credentialName, credentialValue } from './redaction.mjs';

// Provider account settings name the account a credential acts on.
const provider = /^(CLOUDFLARE_|CF_|AWS_)/i;
// Credential words inside a name, also run together: PGPASSWORD, CLIENTSECRET,
// GPG_PASSPHRASE, CI_JOB_JWT, DOCKER_CREDS, SLACK_WEBHOOK_URL, BASICAUTH.
const credentialPart = /TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|CREDENTIAL|CREDS|JWT|COOKIE|WEBHOOK|AUTH(?!OR)|(API|ACCESS|PRIVATE|SIGNING|ENCRYPTION|MASTER|LICENSE)_?KEY/i;
// The install reaches its registry through these, credentials included.
const proxy = /^(https?_proxy|all_proxy|no_proxy)$/i;
// Kept whatever their value looks like: a directory may resemble a token.
const ordinary = /^(PATH|HOME|CI|LANG|LANGUAGE|LC_[A-Z]+)$/;

export function dependencyEnvironment(env = process.env) {
 return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined
  && (proxy.test(key) || ordinary.test(key) || !(credentialName(key) || credentialPart.test(key) || provider.test(key) || applicationBindings.test(key) || credentialValue(value)))));
}
