import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { pacedClient, fail } from './common.mjs';
import { clientCredential, originOf, mintToken } from './zendesk-token.mjs';

const routes = /^\/(?:oauth\/tokens|api\/v2\/(?:oauth\/tokens\/current|incremental\/(?:tickets\/cursor|users\/cursor|organizations)(?:\.json)?|tickets\/\d+\/comments(?:\.json)?|ticket_fields(?:\.json)?|help_center\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?\/articles\/\d+|(?:user_segments|categories|sections|articles)(?:\/\d+\/(?:translations|attachments))?(?:\.json)?)))$/u;
const queries = new Set(['start_time', 'per_page', 'cursor', 'page', 'page[size]', 'page[after]', 'include_inline_images']);
export const attachmentPath = path => /^\/(?:attachments\/|api\/v2\/attachments\/)/u.test(path);
const privateAddress = address => {
 if (isIP(address) === 4) {
  const [a,b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a >= 224 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 || a === 192 && (b === 0 || b === 88);
 }
 // Only global unicast IPv6; mapped IPv4, loopback, multicast and ULA fail.
 return !/^2[0-9a-f]{3}:/iu.test(address) || /^2001:(?:db8|0):/iu.test(address);
};
export async function publicLocation(value, origin) {
 let url;
 try { url = new URL(value, origin); } catch { return null; }
 if (/^https:\/\/[^/?#]*:\d+(?:[/?#]|$)/iu.test(String(value)) || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || isIP(url.hostname) || url.hostname.startsWith('[')
  || url.hostname.length > 253 || !url.hostname.split('.').every(part => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(part)) || !url.hostname.includes('.')
  || /\.(?:localhost|local|internal|invalid|test|home|lan)$/u.test(url.hostname) || /^\d+$/u.test(url.hostname.split('.').at(-1))) return null;
 if (url.origin !== origin) {
  let addresses;
  try { addresses = await lookup(url.hostname, { all: true }); } catch { return null; }
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) return null;
 }
 return url;
}
export function pagination(value, origin, pathname, current) {
 if (value === null) return null;
 if (typeof value !== 'string' || !value || value.length > 4096) fail('INVALID_PAGINATION');
 let next;
 try { next = new URL(value, origin); } catch { fail('INVALID_PAGINATION'); }
 if (next.origin !== origin || next.username || next.password || next.hash || next.pathname.replace(/\.json$/u, '') !== pathname.replace(/\.json$/u, '')
  || [...next.searchParams.keys()].some(key => !queries.has(key) || next.searchParams.getAll(key).length !== 1) || next.href === new URL(current, origin).href) fail('INVALID_PAGINATION');
 return pathname + next.search;
}
export async function transport({ inputs, key, signal, beforeRequest }) {
 const origin = originOf(inputs), credentials = clientCredential(key);
 const request = pacedClient({ origin, signal, beforeRequest, secrets: [key, credentials.client_id, credentials.client_secret], validate: async (url, options) => {
  if (options.attachment) {
   if (!await publicLocation(url.href, origin) || url.origin === origin && !attachmentPath(url.pathname)) fail('REFUSED_LOCATION');
  } else if (url.origin !== origin || url.username || url.password || url.hash || !routes.test(url.pathname) || [...url.searchParams.keys()].some(key => !queries.has(key))) fail('INVALID_REFERENCE');
 } });
 await mintToken(request, key);
 return { request, origin };
}
