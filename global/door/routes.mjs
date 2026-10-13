// How the door reads a request: which Host it names, and whether it may start
// a stopped site. Measured facts behind the start rule (Chromium 140-154,
// WebKit 26, Safari 27): only a top-level document navigation carries
// Sec-Fetch-Mode navigate with Sec-Fetch-Dest document; iframes say iframe,
// subresources and fetch say no-cors/cors, Chromium sends no Sec-Fetch-* on a
// WebSocket upgrade, and an open tab's Vite ping is a fetch.
import { isLocalhostName } from '../../modules/operator-auth/loopback.mjs';

export const indexHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

// { kind: 'index' | 'site' | 'redirect' | 'foreign', name?, host?, canonical? }
// Matching is case-insensitive: any letter case of a door Host is answered as
// the lowercase Host is, and `host` is that canonical lowercase spelling, which
// the door sends upstream (a site's dev server allows only lowercase
// *.localhost). A trailing-dot Host redirects to the canonical Host.
export function readHost(header, port) {
 const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(String(header ?? '').toLowerCase());
 if (!match || Number(match[2] ?? 80) !== port) return { kind: 'foreign' };
 const hostname = match[1].replace(/\.+$/, ''), host = `${hostname}:${port}`;
 const index = indexHostnames.has(hostname);
 if (!index && !isLocalhostName(hostname)) return { kind: 'foreign' };
 if (hostname !== match[1]) return { kind: 'redirect', canonical: host };
 if (index) return { kind: 'index', host };
 // Subdomains route to their site: x.cradle.localhost is cradle.
 return { kind: 'site', name: hostname.slice(0, -'.localhost'.length).split('.').pop(), host };
}

const refererOrigin = value => { try { return new URL(value).origin; } catch { return undefined; } };

// 'start': a top-level navigation the person made (typed, bookmarked, same
// site, from the door's own index, or a client without fetch metadata asking
// for HTML). 'confirm': another site's navigation, which gets a Start button.
// 'never': everything else (subresources, fetch/XHR, prefetch, OPTIONS, other
// methods and every WebSocket upgrade).
export function startKind(request, indexOrigins) {
 const headers = request.headers;
 if (headers.upgrade || !['GET', 'HEAD'].includes(request.method)) return 'never';
 if (headers['sec-purpose'] || headers.purpose || headers['x-purpose'] || headers['x-moz'] === 'prefetch') return 'never';
 const mode = headers['sec-fetch-mode'], dest = headers['sec-fetch-dest'], site = headers['sec-fetch-site'];
 if (mode === undefined && dest === undefined && site === undefined) return /\btext\/html\b/i.test(headers.accept ?? '') ? 'start' : 'never';
 if (mode !== 'navigate' || dest !== 'document') return 'never';
 if (['none', 'same-origin', 'same-site'].includes(site)) return 'start';
 if (indexOrigins.has(refererOrigin(headers.referer))) return 'start';
 return 'confirm';
}
