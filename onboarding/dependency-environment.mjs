// A dependency install runs code the seed did not write: the package manager
// and every build script it allows (esbuild, workerd, sharp, oxide). It gets
// the caller's environment without provider credentials, application bindings
// or any variable whose name or value marks a credential. The seed's own
// commands that need them, such as deploy, still receive them.
import { applicationBindings } from './local/environment.mjs';
import { credentialName, credentialUrl } from './redaction.mjs';

// Provider account settings name the account a credential acts on.
const provider = /^(CLOUDFLARE_|CF_)/;
// The install reaches its registry through these, credentials included.
const proxy = /^(https?_proxy|all_proxy|no_proxy)$/i;

export function dependencyEnvironment(env = process.env) {
 return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined
  && (proxy.test(key) || !(credentialName(key) || provider.test(key) || applicationBindings.test(key) || credentialUrl(value)))));
}
