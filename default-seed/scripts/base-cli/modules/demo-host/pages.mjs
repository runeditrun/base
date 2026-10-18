// The demo host's two pages, from their 12ui designs: the start page (the
// Turnstile managed widget starts the demo by itself, start-script.mjs) and the ended page.
// Both are one card in the family's quiet sign-in style.
import { START_SCRIPT } from './start-script.mjs';
import { STYLE } from './page-style.mjs';
import { LOGO_SCRIPT } from './theme-script.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

// The console's chunks, fetched at idle priority while the visitor waits for
// the check and sign-in (native/warm.mjs). The browser ignores a failed one,
// and one with prefetching turned off fetches none.
const warm = env => (env.DEMO_WARM ?? []).map(path => `<link rel="prefetch" href="${escape(path)}">`).join('');

function html(env, { page, title, body, status = 200, headers = {}, turnstile = false, refresh = false }) {
  const nonce = crypto.randomUUID().replaceAll('-', ''), site = new URL(env.DEMO_SITE);
  const policy = `default-src 'none'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'${turnstile ? ` https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com` : ''}`;
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title>${env.DEMO_ICON_HEAD ?? ''}${refresh ? '<noscript><meta http-equiv="refresh" content="2;url=/__demo/status"></noscript>' : ''}${(env.DEMO_THEME ?? []).map(path => `<link rel="stylesheet" href="${escape(path)}">`).join('')}<style nonce="${nonce}">${STYLE}</style>${turnstile ? `<noscript><style nonce="${nonce}">#note{display:none}</style></noscript><script nonce="${nonce}">${START_SCRIPT}</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>${warm(env)}` : ''}</head>
<body class="${page}"><main><section class="card" aria-labelledby="title"><p class="brand"><img class="mark" alt="${escape(env.DEMO_NAME)}" width="40" height="40" hidden><span>${escape(env.DEMO_NAME)}</span></p>${body}</section><nav class="back" aria-label="Return"><a href="${escape(site.origin)}/">Back to ${escape(site.host)}</a></nav></main><script nonce="${nonce}">${LOGO_SCRIPT}</script></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': policy, 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', ...headers } });
}

/** GET /: the visitor proves they are human and their demo starts. `notice` explains a refused start. */
export function startPage(env, { status = 200, notice, pending = false, headers = {} } = {}) {
  const name = escape(env.DEMO_NAME);
  return html(env, { page: 'start', title: `Try ${env.DEMO_NAME}`, status, headers, turnstile: true, refresh: pending, body: `<h1 id="title">Try ${name}</h1>
<p class="intro">Your own copy of ${name}, signed in as its owner, with sample data.</p>
<ul><li>Public checks run live. Messages and account changes are simulated.</li><li>It ends after an hour, or 15 idle minutes.</li><li>Then it is deleted. Nobody else can see it.</li></ul>
<p class="notice" id="notice" role="alert"${notice ? '' : ' hidden'}>${notice ? escape(notice) : ''}</p><form id="start" method="post" action="/__demo/start" data-auto="${notice || pending ? '0' : '1'}"${pending ? ' data-resume="1" data-state="working"' : ''}><div class="cf-turnstile" data-sitekey="${escape(env.TURNSTILE_SITE_KEY)}" data-size="flexible" data-callback="rerDemoVerified" data-before-interactive-callback="rerDemoInteractive" data-after-interactive-callback="rerDemoChecking" data-expired-callback="rerDemoExpired" data-error-callback="rerDemoCheckFailed"></div>
<button class="button" type="submit"${pending ? ' disabled' : ''}><span class="spinner" aria-hidden="true"></span><span class="label">${pending ? 'Starting your demo…' : 'Start the demo'}</span></button>
<ol class="steps" aria-hidden="true"><li data-at="done">Checking you're human</li><li data-at="now">Starting a private copy</li><li data-at="next">Signing you in</li></ol>
<p class="note" id="note">${pending ? 'Your demo will open automatically when ready.' : 'Complete the human check to start your demo.'}</p><noscript><p class="note">The human check needs JavaScript. Turn it on to start the demo.</p></noscript><p class="visually-hidden" id="status" role="status"></p></form>` });
}

/** A demo signed out of, or whose hour or idle time is up: its isolate and data are gone. */
export function endedPage(env, { status = 410, headers = {} } = {}) {
  const name = escape(env.DEMO_NAME);
  return html(env, { page: 'ended', title: 'This demo has ended', status, headers, body: `<h1 id="title">This demo has ended</h1>
<p class="intro">A demo ends when you sign out, after an hour, or after 15 minutes with nothing happening. Its copy of ${name} and everything in it have been deleted.</p>
<a class="button" href="${escape(env.DEMO_ORIGIN)}/">Start a new demo</a><p class="secondary"><a href="${escape(new URL(env.DEMO_SITE).origin)}/run">Run ${name} yourself</a></p>` });
}

const cookie = (env, value, seconds) => `rer_demo=${value}; Domain=${new URL(env.DEMO_ORIGIN).hostname}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
/** The visitor's demo: HttpOnly, Secure, SameSite=Lax, for demo.<domain> and its subdomains, one hour. */
export const demoCookie = (env, id) => cookie(env, id, 3600);
export const clearCookie = env => cookie(env, '', 0);
