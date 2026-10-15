// The demo host's two pages, from their 12ui designs: the start page (the
// Turnstile managed widget submits the form by itself) and the ended page.
// Both are one card in the family's quiet sign-in style.
const escape = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

const STYLE = `*{box-sizing:border-box}body{margin:0;background:#f2f5f7;color:#192333;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:666px;margin:clamp(32px,18vh,184px) auto 48px}.card{padding:40px 42px 44px;background:#fff;border:1px solid #d6dfe9;border-radius:18px;box-shadow:0 12px 45px rgba(42,65,86,.05)}
.mark{width:35px;height:6px;border-radius:4px;background:#20574d;margin:0 0 20px}.brand{font-size:18px;line-height:22px;font-weight:600;color:#527875;margin:0 0 14px}
h1{font-size:42px;line-height:50px;letter-spacing:-1.3px;margin:0 0 14px;font-weight:700}.intro{font-size:20px;line-height:28px;color:#41516a;margin:0}
ul{padding:0;margin:23px 0 35px;list-style:none;color:#31415a;font-size:18px;line-height:33px}li{position:relative;padding-left:33px}li:before{content:'';position:absolute;left:7px;top:14px;width:7px;height:7px;background:#2b7864;border-radius:50%}
.notice{margin:0 0 16px;padding:12px 16px;border-radius:8px;background:#fdf6ec;color:#6b3d0f;font-size:16px;line-height:22px}
.cf-turnstile{min-height:65px}.button{display:block;width:100%;margin-top:28px;min-height:58px;border:1px solid #86a49f;border-radius:11px;background:linear-gradient(110deg,#225b51,#1e5148 60%,#20584d);color:#fff;font:inherit;font-size:20px;font-weight:700;line-height:26px;padding:15px;text-align:center;text-decoration:none;cursor:pointer}
.button:disabled{opacity:.7;cursor:progress}.button:focus-visible,a:focus-visible{outline:3px solid #388c77;outline-offset:4px}
.note{font-size:15px;line-height:21px;color:#50617e;text-align:center;margin:21px 0 0}.secondary{text-align:center;margin:22px 0 0;font-size:18px;line-height:24px;font-weight:600}.secondary a{color:#1b554e;text-underline-offset:3px}
.back{text-align:center;margin:32px 0 0;font-size:15px;line-height:22px}.back a{color:#1b554e;text-underline-offset:3px}
.ended main{width:min(560px,calc(100% - 32px));margin-top:clamp(32px,26vh,262px)}.ended .card{padding:28px 36px 42px}.ended .brand{font-size:16px;margin-bottom:26px}.ended h1{font-size:36px;line-height:44px;margin-bottom:22px}.ended .intro{margin-bottom:36px}.ended .button{margin-top:0;font-size:18px}
@media(min-width:600px) and (max-width:1023px){main{width:calc(100% - 64px);max-width:666px;margin:100px auto 48px}.card{padding:36px}h1{font-size:38px;line-height:46px}.intro{font-size:18px;line-height:27px}}
@media(max-width:599px){main,.ended main{width:calc(100% - 32px);margin:32px auto}.ended .card{padding:26px 22px}.ended h1{font-size:29px;line-height:36px}.ended .intro{font-size:17px;line-height:25px;margin-bottom:28px}.card{padding:26px 22px;border-radius:16px}.brand{font-size:16px}h1{font-size:34px;line-height:41px;letter-spacing:-.8px}.intro{font-size:17px;line-height:25px}ul{font-size:16px;line-height:25px;margin:22px 0 26px}li{padding-left:22px;margin-bottom:9px}li:before{left:2px;top:9px}.button{font-size:18px;margin-top:22px}.note{font-size:13px;line-height:20px}.back{margin-top:24px;font-size:14px}}`;

// Starts the demo once Turnstile has passed: the widget put its token in the form.
// After a refused start the page waits for the visitor's own click instead.
const SCRIPT = `function rerDemoBusy(){document.querySelector('#start button').disabled=true;document.getElementById('status').textContent='Starting your demo…'}
function rerDemoStart(){rerDemoBusy();document.getElementById('start').submit()}
function rerDemoReady(){document.querySelector('#start button').disabled=false}
addEventListener('DOMContentLoaded',()=>document.getElementById('start').addEventListener('submit',rerDemoBusy))`;

function html(env, { page, title, body, status = 200, headers = {}, turnstile = false }) {
  const nonce = crypto.randomUUID().replaceAll('-', ''), site = new URL(env.DEMO_SITE);
  const policy = `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${turnstile ? `; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com` : ''}`;
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style nonce="${nonce}">${STYLE}</style>${turnstile ? `<script nonce="${nonce}">${SCRIPT}</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}</head>
<body class="${page}"><main><section class="card" aria-labelledby="title"><div class="mark" aria-hidden="true"></div><p class="brand">${escape(env.DEMO_NAME)}</p>${body}</section><nav class="back" aria-label="Return"><a href="${escape(site.origin)}/">Back to ${escape(site.host)}</a></nav></main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': policy, 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', ...headers } });
}

/** GET /: the visitor proves they are human and their demo starts. `notice` explains a refused start. */
export function startPage(env, { status = 200, notice, headers = {} } = {}) {
  const name = escape(env.DEMO_NAME);
  return html(env, { page: 'start', title: `Try ${env.DEMO_NAME}`, status, headers, turnstile: true, body: `<h1 id="title">Try ${name}</h1>
<p class="intro">Your own copy of ${name}, signed in as its owner, with sample data.</p>
<ul><li>Nothing is sent: mail stays in an outbox.</li><li>It ends after an hour, or 15 idle minutes.</li><li>Then it is deleted. Nobody else can see it.</li></ul>
${notice ? `<p class="notice" role="alert">${escape(notice)}</p>` : ''}<form id="start" method="post" action="/__demo/start"><div class="cf-turnstile" data-sitekey="${escape(env.TURNSTILE_SITE_KEY)}" data-size="flexible" data-callback="${notice ? 'rerDemoReady' : 'rerDemoStart'}"></div>
<button class="button" type="submit" disabled>Start the demo</button><p class="note" id="status" role="status">Starts by itself once the check passes. Takes about ten seconds.</p></form>` });
}

/** A demo whose hour or idle time is up: its container and data are gone. */
export function endedPage(env, { status = 410, headers = {} } = {}) {
  const name = escape(env.DEMO_NAME);
  return html(env, { page: 'ended', title: 'This demo has ended', status, headers, body: `<h1 id="title">This demo has ended</h1>
<p class="intro">Demos last an hour, or until 15 minutes pass with nothing happening. Its copy of ${name} and everything in it have been deleted.</p>
<a class="button" href="/">Start a new demo</a><p class="secondary"><a href="${escape(new URL(env.DEMO_SITE).origin)}/run">Run ${name} yourself</a></p>` });
}

const cookie = (env, value, seconds) => `rer_demo=${value}; Domain=${new URL(env.DEMO_ORIGIN).hostname}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
/** The visitor's demo: HttpOnly, Secure, SameSite=Lax, for demo.<domain> and its subdomains, one hour. */
export const demoCookie = (env, id) => cookie(env, id, 3600);
export const clearCookie = env => cookie(env, '', 0);
