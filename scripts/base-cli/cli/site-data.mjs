import { identityPattern } from './site-check.mjs';

// HTML Living Standard named character references (Python html.entities.html5).
import entities from './site-entities.json' with {type:'json'};
const numericReplacements = {128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376};
export function decodedText(text) {
 return text.replace(/&#(?:x([\da-f]+)|(\d+));?|&([a-z][a-z0-9]*;?)/gi, (match, hex, decimal, name) => {
  if (name) {
   for (let length = name.length; length; length--) if (entities[name.slice(0,length)] !== undefined) return entities[name.slice(0,length)] + name.slice(length);
   return match;
  }
  const code = parseInt(hex ?? decimal, hex ? 16 : 10);
  return String.fromCodePoint(numericReplacements[code] ?? (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code));
 }).replace(/(?:%[\da-f]{2})+/gi, value => {try {return decodeURIComponent(value);} catch {return value;}})
  .replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|u\{([\da-f]+)\})/gi, (match, hex, unicode, point) => {
   const code = parseInt(hex ?? unicode ?? point,16); return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

// Scan every emitted file, including binary assets. Decode textual forms as well
// as matching base64 directly, so encoding a registered value cannot publish it.
export function privateDataScanner(values, identities) {
 const secrets = values.filter(value => typeof value === 'string' && value.length);
 const owners = identities.filter(value => typeof value === 'string' && value.length).map(value => ({value, ...identityPattern(value)}));
 const encodings = value => [Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64').replace(/=+$/, ''), Buffer.from(value).toString('base64url')];
 const encodedSecrets = secrets.flatMap(encodings);
 const encodedOwners = owners.flatMap(({value}) => encodings(value)).map(value => new RegExp(`(?<![A-Za-z0-9+/_-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9+/_=-])`));
 return (bytes, literalValues = []) => {
  if (secrets.some(value => bytes.includes(Buffer.from(value)))) return true;
  const raw = bytes.toString('utf8');
  const forms = new Set([raw, ...literalValues]);
  for (const value of [raw, ...literalValues]) {
   let decoded = value;
   for (let depth = 0; depth < 4; depth++) { decoded = decodedText(decoded); forms.add(decoded); }
  }

  for (const form of forms) {
   // Complete string values preserve the whitespace that atob accepts, even
   // when the payload spans lines or carries encoded whitespace.
   const compact = form.replace(/[\t\n\f\r ]/g, '');
   if (/^[A-Za-z0-9+/_-]{8,}={0,2}$/.test(compact) && compact.length % 4 !== 1) {
    const plain = Buffer.from(compact, 'base64').toString('utf8');
    forms.add(plain); forms.add(decodedText(plain));
   }
   if (secrets.some(value => form.includes(value)) || owners.some(({pattern}) => pattern.test(form))) return true;
   if (encodedSecrets.some(value => form.includes(value)) || encodedOwners.some(pattern => pattern.test(form))) return true;
   // A base64 payload may include surrounding text, changing its alignment.
   for (const match of form.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) for (let offset = 0; offset < 4; offset++) {
    const plain = Buffer.from(match[0].slice(offset), 'base64').toString('utf8');
    if (secrets.some(value => plain.includes(value)) || owners.some(({pattern}) => pattern.test(plain))) return true;
   }
  }
  return false;
 };
}
