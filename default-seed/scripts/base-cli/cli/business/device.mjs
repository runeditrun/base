import { hostname, userInfo } from 'node:os';

/** A plain name for this computer, from its host name: the first label only,
 * words instead of dashes, the login name removed, at most 64 characters, and
 * never a path. Empty when nothing plain is left, so the server names the
 * computer by its system and agent instead.
 */
export function deviceName({ host = hostname(), user = loginName() } = {}) {
 let name = String(host).split('.')[0].replace(/[\x00-\x1f\x7f/\\]/g, ' ').replace(/[-_]+/g, ' ');
 // The login name, and the possessive Apple host names add to a person's name ("jamess").
 if (user && user.length > 1) name = name.replace(new RegExp(`(?<![\\p{L}\\p{N}])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![\\p{L}\\p{N}])`, 'giu'), ' ');
 return Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, 64).join('').trim();
}
function loginName() { try { return userInfo().username; } catch { return ''; } }

/** The absolute folder connect runs in, as the platform accepts it: an
 * absolute path without control characters, at most 1000 characters. */
export function workingFolder(folder = process.cwd()) {
 return typeof folder === 'string' && folder.startsWith('/') && folder.length <= 1000 && !/[\x00-\x1f\x7f]/.test(folder) ? folder : '';
}
