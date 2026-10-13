// The door makes every cookie a site sets host-only when its Domain names
// localhost itself: WebKit stores Domain=localhost (and its dotted spellings,
// such as localhost. and .localhost.) for every *.localhost site and plain
// localhost, so one site's cookie would reach every other. It applies to every
// reply that can carry Set-Cookie: HTTP replies and WebSocket handshake replies.

// A Domain value as a browser reads it: whitespace and quotes trimmed, leading
// and trailing dots ignored, any letter case.
const namesLocalhost = value => value.trim().replace(/^"(.*)"$/, '$1').trim().replace(/^\.+|\.+$/g, '').toLowerCase() === 'localhost';

// One Set-Cookie value with each Domain attribute that names localhost removed.
export function hostOnlyCookie(value) {
 const [pair, ...attributes] = String(value).split(';');
 const kept = attributes.filter(attribute => {
  const at = attribute.indexOf('=');
  return at < 0 || attribute.slice(0, at).trim().toLowerCase() !== 'domain' || !namesLocalhost(attribute.slice(at + 1));
 });
 return [pair, ...kept].join(';');
}

// An HTTP response head (status line and headers, without the blank line) as
// bytes, read the way browsers read it (CRLF or bare LF line ends, folded
// continuation lines joined), with every Set-Cookie made host-only.
export function hostOnlyHead(head) {
 const lines = [];
 for (const line of head.toString('latin1').split(/\r?\n/)) {
  if (/^[ \t]/.test(line) && lines.length > 1) lines[lines.length - 1] += ' ' + line.trim();
  else lines.push(line);
 }
 return Buffer.from(lines.map((line, index) => {
  const at = line.indexOf(':');
  return index > 0 && at > 0 && line.slice(0, at).trim().toLowerCase() === 'set-cookie' ? `${line.slice(0, at)}: ${hostOnlyCookie(line.slice(at + 1).trim())}` : line;
 }).join('\r\n') + '\r\n\r\n', 'latin1');
}

// The end of a response head in `buffer`: { head, rest }, or undefined while
// the blank line has not arrived.
export function splitHead(buffer) {
 const match = /\r?\n\r?\n/.exec(buffer.toString('latin1'));
 return match && { head: buffer.subarray(0, match.index), rest: buffer.subarray(match.index + match[0].length) };
}
