/** Whether a name (an object key, a header name, the name in a `[name, value]`
 * pair, a URL query or fragment key) names a credential, by its whole parts.
 *
 * A name is split into lower-case parts at camelCase and PascalCase boundaries
 * (`apiKey`, `XAPIKey`), at `_`, `-`, `.`, spaces and any other non-letter, and
 * at digits (`token2` is `token`). A name is a credential when its last parts
 * are a credential word or phrase, never because a part only contains one:
 * `keyword`, `monkey`, `author`, `signal`, `design` and `tokenizer` hold the
 * letters of a credential word and are not credentials. */
export interface CredentialName {
  /** The name's letters, lower-cased: `apiKey` and `api_key` are both `apikey`. */
  name: string;
  /** The word's plural (`tokens`, `apiKeys`): it holds credentials only as text, so a count stays. */
  plural: boolean;
}
export type CredentialNameContext = 'field' | 'query';

const WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'cookie', 'authorization', 'bearer', 'credential']);
/** Words that make a trailing `key` a credential: `api key`, `secret key`, `Ocp-Apim-Subscription-Key`. A bare `key` or `primaryKey` is not. */
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'auth', 'client', 'integration', 'routing', 'service', 'signing', 'session',
  'refresh', 'subscription', 'functions', 'consumer', 'app', 'license', 'master', 'encryption', 'admin']);
/** The same words written as one lower-case part (`apikey`, `accesstoken`, `clientsecret`, `httppassword`, `sessionid`, `webhookurl`). */
const COMPOUND = new RegExp('^x?(?:'
  + `(?:${[...KEY_QUALIFIERS].join('|')})(?:key)|(?:access|refresh|auth|api|bearer|id|session|csrf|xsrf|bot|push|oauth|jwt)(?:token)`
  + '|(?:client|app|api|oauth|webhook|signing|shared)(?:secret)|(?:http|db|ftp|smtp|admin|user|basic|proxy|root|mail|login)(?:password|passwd|pwd)'
  + '|session(?:id)|webhook(?:url)|cal(?:url))(s?)$');

/** A name's lower-case parts, without digits. Format characters and accents are folded away first. */
export function nameParts(name: string): string[] {
  const text = name.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '');
  return (text.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lo}+/gu) ?? []).map(part => part.toLowerCase());
}

export function credentialName(name: string, context: CredentialNameContext = 'field'): CredentialName | undefined {
  const parts = nameParts(name), last = parts.at(-1), before = parts.at(-2);
  if (last === undefined) return undefined;
  const letters = () => name.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '').slice(-64);
  const found = (plural: boolean) => ({ name: letters(), plural });
  const compound = COMPOUND.exec(last);
  if (compound) return found(compound[1] === 's');
  const singular = last.endsWith('s') ? last.slice(0, -1) : undefined;
  if (WORDS.has(last)) return found(false);
  // `credentials` holds a credential object as one value; the other plurals hold a list or map of text.
  if (last === 'credentials') return found(false);
  if (singular !== undefined && WORDS.has(singular)) return found(true);
  const qualifier = (word: string | undefined) => word !== undefined && (KEY_QUALIFIERS.has(word) || (word.startsWith('x') && KEY_QUALIFIERS.has(word.slice(1))));
  if (last === 'key' && (qualifier(before) || (context === 'query' && parts.length === 1))) return found(false);
  if (last === 'keys' && qualifier(before)) return found(true);
  if (last === 'id' && before === 'session') return found(false);
  if (last === 'url' && (before === 'webhook' || before === 'cal')) return found(false);
  // A signature is a credential as a query key (an Azure SAS `sig`, `X-Amz-Signature`) and as a whole name.
  if ((last === 'sig' || last === 'signature') && (context === 'query' || parts.length === 1)) return found(false);
  if (last === 'auth' && (parts.length === 1 || (parts.length === 2 && before === 'x'))) return found(false);
  return undefined;
}
