// Short aliases need word boundaries: AUTHOR_NAME, MONKEY_NAME and
// KEYBOARD_LAYOUT are ordinary public names. Long credential stems also match
// run-together identifiers, independent of case or separators. Lexical
// derivatives (tokenizer/tokenization and secretary/secretariat) aren't secrets.
const CREDENTIAL_WORD = 'token|secret|credential|key|pat|dsn|auth|pass|passwd|password|pwd|signature|sig|cookie|apikey|accesskey|privatekey|secretkey|authtoken|accesstoken';
const CREDENTIAL_NAME = new RegExp(`(?:^|[_.-])(?:${CREDENTIAL_WORD})s?(?:$|[_.-])`, 'i');
const CREDENTIAL_STEM = /token(?!iz)|secret(?!ar)|credential|password|passwd|passphrase|(?:api|access|private|signing)key|signature|cookie|pwd|dsn/;

export function credentialName(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').replace(/([A-Za-z])([0-9])/g, '$1_$2');
  const normalized = key.toLowerCase().replace(/[_.-]/g, '');
  return CREDENTIAL_NAME.test(words) || CREDENTIAL_STEM.test(normalized);
}

/** Shared public-input boundary, including installer-owned vault bindings. */
export function setupFieldIsSecret(field, secretScopes = {}) {
  return field.kind === 'secret' || field.type === 'password' || field.secret === true
    || credentialName(field.name) || /^RER_/i.test(field.name)
    || Object.hasOwn(secretScopes, field.name);
}
