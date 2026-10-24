// A credential word is a whole delimited part, or a real camelCase suffix.
// Ordinary names such as AUTHOR_NAME and KEYBOARD_LAYOUT stay public.
const CREDENTIAL_WORD = 'token|secret|credential|key|pat|dsn|auth|pass|passwd|password|pwd|signature|sig|cookie|apikey|accesskey|privatekey|secretkey|authtoken|accesstoken';
const CREDENTIAL_NAME = new RegExp(`(?:^|[_.-])(?:${CREDENTIAL_WORD})s?(?:$|[_.-])`, 'i');
const CAMEL_CREDENTIAL_NAME = /[A-Za-z0-9](?:Token|Secret|Credential|Key|Pat|Dsn|Auth|Pass|Passwd|Password|Pwd|Signature|Sig|Cookie)s?(?:$|[_.-]|[A-Z0-9])/;

export const credentialName = key => CREDENTIAL_NAME.test(key) || CAMEL_CREDENTIAL_NAME.test(key);

/** Shared public-input boundary, including installer-owned vault bindings. */
export function setupFieldIsSecret(field, secretScopes = {}) {
  return field.kind === 'secret' || field.type === 'password' || field.secret === true
    || credentialName(field.name) || /^RER_/i.test(field.name)
    || Object.hasOwn(secretScopes, field.name);
}
