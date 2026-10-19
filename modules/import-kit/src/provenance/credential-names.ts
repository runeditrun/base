/** Whether a name (an object key, a header name, the name in a `[name, value]`
 * pair, a URL query or fragment key) names a credential, by its whole parts.
 *
 * A name is split into lower-case parts at camelCase and PascalCase boundaries
 * (`apiKey`, `XAPIKey`), at `_`, `-`, `.`, spaces and any other non-letter, and
 * at digits (`token2` is `token`). A name is a credential when its parts are a
 * credential word or phrase, never because a part only contains one: `keyword`,
 * `monkey`, `author`, `signal`, `design` and `tokenizer` hold the letters of a
 * credential word and are not credentials. */
export interface CredentialName {
  /** The name's letters, lower-cased: `apiKey` and `api_key` are both `apikey`. */
  name: string;
  /** The word's plural (`tokens`, `apiKeys`): it holds credentials only as text, so a count stays. */
  plural: boolean;
}
/** `refuse`: the whole name is a credential phrase, so a pagination cursor such as
 * `next_page_token` or a count such as `input_tokens` is not one. `remove`: the
 * name ends in a credential word (`pushToken`, `webhook_url`), the wider net of
 * the import door, which drops the value and keeps the record. `query`: a URL
 * query or fragment key, as `remove` plus a bare `key` and `X-Amz-Signature`. */
export type CredentialNameMode = 'refuse' | 'remove' | 'query';

const WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'cookie', 'authorization', 'bearer', 'credential']);
/** Words that make a trailing `key` a credential: `api key`, `secret key`, `Ocp-Apim-Subscription-Key`. A bare `key` or `primaryKey` is not. */
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'auth', 'client', 'integration', 'routing', 'service', 'signing', 'session',
  'refresh', 'subscription', 'functions', 'consumer', 'app', 'license', 'master', 'encryption', 'admin']);
const TOKEN_QUALIFIERS = ['access', 'refresh', 'auth', 'api', 'bearer', 'id', 'session', 'csrf', 'xsrf', 'bot', 'push', 'oauth', 'jwt'];
const SECRET_QUALIFIERS = ['client', 'app', 'api', 'oauth', 'webhook', 'signing', 'shared'];
const PASSWORD_QUALIFIERS = ['http', 'db', 'ftp', 'smtp', 'admin', 'user', 'basic', 'proxy', 'root', 'mail', 'login'];
/** What may stand before a credential word in `refuse` mode, which names the whole phrase (`access token`, `http password`). */
const QUALIFIERS: Record<string, ReadonlySet<string>> = {
  token: new Set(TOKEN_QUALIFIERS), secret: new Set(SECRET_QUALIFIERS),
  password: new Set(PASSWORD_QUALIFIERS), passwd: new Set(PASSWORD_QUALIFIERS), pwd: new Set(PASSWORD_QUALIFIERS),
  key: KEY_QUALIFIERS,
};
/** The same phrases written as one lower-case part (`apikey`, `accesstoken`, `clientsecret`, `httppassword`, `sessionid`, `webhookurl`). */
const COMPOUND = new RegExp('^x?(?:'
  + `(?:${[...KEY_QUALIFIERS].join('|')})(?:key)|(?:${TOKEN_QUALIFIERS.join('|')})(?:token)|(?:${SECRET_QUALIFIERS.join('|')})(?:secret)`
  + `|(?:${PASSWORD_QUALIFIERS.join('|')})(?:password|passwd|pwd)|session(?:id)|webhook(?:url)|cal(?:url))(s?)$`);

/** A name's lower-case parts, without digits. Format characters and accents are folded away first. */
export function nameParts(name: string): string[] {
  const text = name.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '');
  return (text.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lo}+/gu) ?? []).map(part => part.toLowerCase());
}

export function credentialName(name: string, mode: CredentialNameMode): CredentialName | undefined {
  const parts = nameParts(name), last = parts.at(-1), before = parts.at(-2);
  if (last === undefined) return undefined;
  const letters = name.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '').slice(-64);
  const compound = COMPOUND.exec(last);
  if (compound) return { name: letters, plural: compound[1] === 's' };
  // A header's leading `x-` (`x-api-key`, `X-Auth-Token`) is not part of the phrase; `refuse` mode takes the rest whole.
  const phrase = parts.length > 1 && parts[0] === 'x' ? parts.slice(1) : parts;
  const found = (plural: boolean) => ({ name: letters, plural });
  const qualifier = (word: string | undefined) => word !== undefined && (KEY_QUALIFIERS.has(word) || (word.startsWith('x') && KEY_QUALIFIERS.has(word.slice(1))));
  const strict = mode === 'refuse';
  // `credentials` holds a credential object as one value; the other plurals hold a list or map of text.
  const word = last === 'credentials' ? 'credential' : WORDS.has(last) ? last : last.endsWith('s') && WORDS.has(last.slice(0, -1)) ? last.slice(0, -1) : undefined;
  if (word !== undefined) {
    const plural = word !== last && last !== 'credentials';
    // `refuse` mode: the word alone or after one qualifier (`token`, `access_token`), and `pwd` after anything.
    const named = phrase.length === 1 || (phrase.length === 2 && QUALIFIERS[word]?.has(phrase[0]) === true) || word === 'pwd';
    if (!strict || named) return found(plural);
  }
  if (last === 'key' || last === 'keys') {
    // `refuse` mode: `api_key`, `x-functions-key`, and `secret`/`subscription`/`functions` before the key under any name.
    const named = phrase.length === 2 || (before !== undefined && ['secret', 'subscription', 'functions'].includes(before));
    if (qualifier(before) && (!strict || named)) return found(last === 'keys');
    // A bare `key` is a credential only as a URL query or fragment key (the `?key=` convention).
    if (mode === 'query' && parts.length === 1 && last === 'key') return found(false);
  }
  if (last === 'id' && before === 'session' && (!strict || phrase.length === 2)) return found(false);
  if (!strict && last === 'url' && (before === 'webhook' || before === 'cal')) return found(false);
  // A signature is a credential as a whole name (an Azure SAS `sig`, a `Signature` field) and, as a query key, as its last part (`X-Amz-Signature`).
  if ((last === 'sig' || last === 'signature') && (mode === 'query' || parts.length === 1)) return found(false);
  if (last === 'auth' && (parts.length === 1 || (parts.length === 2 && before === 'x'))) return found(false);
  return undefined;
}
