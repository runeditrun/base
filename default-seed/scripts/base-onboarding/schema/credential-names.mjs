// Match declared words before considering undivided identifiers. In particular,
// removing separators would turn GOODS_NAME into a spurious DSN match.
const CREDENTIAL_WORDS = new Set([
  'token', 'secret', 'credential', 'key', 'pat', 'dsn', 'auth', 'pass',
  'passwd', 'password', 'passphrase', 'pwd', 'signature', 'sig', 'cookie',
]);
const CREDENTIAL_COMPOUND = /^(?:(?:api|private|access|signing|secret|encryption|ssh|backup)key|(?:api|auth|access)token|githubpat|smtppass)s?$/;
// Only an undivided name gets conservative suffix/long-stem matching. Thus
// MONKEY needs a clearer Business input name, while MONKEY_BUSINESS_NAME is public.
const CREDENTIAL_SUFFIX = /(?:token|secret|credentials?|key|pat|dsn|auth|pass|passwd|password|passphrase|pwd|signature|sig|cookie)s?$/;
const LONG_CREDENTIAL_STEM = /token|secret|password|passwd|credential|passphrase|apikey|privatekey|accesskey|signingkey|signature|cookie/;

export function credentialName(key) {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([A-Za-z])([0-9])/g, '$1_$2')
    .replace(/([0-9])([A-Za-z])/g, '$1_$2')
    .toLowerCase().split(/[_.-]+/).filter(Boolean);
  if (words.some(word => CREDENTIAL_WORDS.has(word)
    || (word.endsWith('s') && CREDENTIAL_WORDS.has(word.slice(0, -1)))
    || CREDENTIAL_COMPOUND.test(word))) return true;
  const runs = words.filter(word => !/^\d+$/.test(word));
  return runs.length === 1
    && (CREDENTIAL_SUFFIX.test(runs[0]) || LONG_CREDENTIAL_STEM.test(runs[0]));
}

/** Shared public-input boundary, including installer-owned vault bindings. */
export function setupFieldIsSecret(field, secretScopes = {}) {
  return field.kind === 'secret' || field.type === 'password' || field.secret === true
    || credentialName(field.name) || /^RER_/i.test(field.name)
    || Object.hasOwn(secretScopes, field.name);
}
