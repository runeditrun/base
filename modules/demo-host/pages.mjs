// The demo host's two pages, from their 12ui designs: the start page (the
// Turnstile managed widget starts the demo by itself, start-script.mjs) and the ended page.
// Both are one card in the family's quiet sign-in style.
import { START_SCRIPT } from './start-script.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

const STYLE = `*{box-sizing:border-box}body{margin:0;background:#f2f5f7;color:#192333;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:666px;margin:clamp(32px,18vh,184px) auto 48px}.card{padding:40px 42px 44px;background:#fff;border:1px solid #d6dfe9;border-radius:18px;box-shadow:0 12px 45px rgba(42,65,86,.05)}
.mark{width:35px;height:6px;border-radius:4px;background:#20574d;margin:0 0 20px}.brand{font-size:18px;line-height:22px;font-weight:600;color:#527875;margin:0 0 14px}
h1{font-size:42px;line-height:50px;letter-spacing:-1.3px;margin:0 0 14px;font-weight:700}.intro{font-size:20px;line-height:28px;color:#41516a;margin:0}
ul{padding:0;margin:23px 0 35px;list-style:none;color:#31415a;font-size:18px;line-height:33px}li{position:relative;padding-left:33px}li:before{content:'';position:absolute;left:7px;top:14px;width:7px;height:7px;background:#2b7864;border-radius:50%}
.notice{margin:0 0 16px;padding:12px 16px;border-radius:8px;background:#fdf6ec;color:#6b3d0f;font-size:16px;line-height:22px}
.cf-turnstile{min-height:65px}.button{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;margin-top:28px;min-height:58px;border:1px solid #86a49f;border-radius:11px;background:linear-gradient(110deg,#225b51,#1e5148 60%,#20584d);color:#fff;font:inherit;font-size:20px;font-weight:700;line-height:26px;padding:15px;text-align:center;text-decoration:none;cursor:pointer}
.button:disabled{cursor:progress}[data-state=waiting] .button{background:#edf3f1;border-color:#78968f;color:#1b4d44;font-weight:600;cursor:default}
.spinner{display:none;flex:none;width:20px;height:20px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}[data-state=working] .spinner,[data-state=signing] .spinner{display:block}@keyframes spin{to{transform:rotate(360deg)}}
ol.steps{display:none;list-style:none;margin:22px auto 0;padding:0;width:max-content;max-width:100%;font-size:16px;line-height:22px;color:#50617e}[data-state=working] .steps,[data-state=signing] .steps,[data-state=slow] .steps{display:grid;gap:10px}[data-state=failed] .note{display:none}
.steps li{padding-left:30px;margin:0}.steps li:before{left:0;top:2px;width:18px;height:18px;box-sizing:border-box;background:none;border:2px solid #7f8da1}.steps [data-at=done]{color:#31415a}.steps [data-at=done]:before{content:'✓';border:0;background:#2b7864;color:#fff;font-size:12px;line-height:18px;font-weight:700;text-align:center}.steps [data-at=now]{color:#192333;font-weight:600}.steps [data-at=now]:before{border-color:#c9dcd7;border-top-color:#20574d;animation:spin .8s linear infinite}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(prefers-reduced-motion:reduce){.spinner,.steps [data-at=now]:before{animation:none}.steps [data-at=now]:before{border-color:#20574d}}.button:focus-visible,a:focus-visible{outline:3px solid #388c77;outline-offset:4px}
.note{font-size:15px;line-height:21px;color:#50617e;text-align:center;margin:21px 0 0}.secondary{text-align:center;margin:22px 0 0;font-size:18px;line-height:24px;font-weight:600}.secondary a{color:#1b554e;text-underline-offset:3px}
.back{text-align:center;margin:32px 0 0;font-size:15px;line-height:22px}.back a{color:#1b554e;text-underline-offset:3px}
.ended main{width:min(560px,calc(100% - 32px));margin-top:clamp(32px,26vh,262px)}.ended .card{padding:28px 36px 42px}.ended .brand{font-size:16px;margin-bottom:26px}.ended h1{font-size:36px;line-height:44px;margin-bottom:22px}.ended .intro{margin-bottom:36px}.ended .button{margin-top:0;font-size:18px}
@media(min-width:600px) and (max-width:1023px){main{width:calc(100% - 64px);max-width:666px;margin:100px auto 48px}.card{padding:36px}h1{font-size:38px;line-height:46px}.intro{font-size:18px;line-height:27px}}
@media(max-width:599px){main,.ended main{width:calc(100% - 32px);margin:32px auto}.ended .card{padding:26px 22px}.ended h1{font-size:29px;line-height:36px}.ended .intro{font-size:17px;line-height:25px;margin-bottom:28px}.card{padding:26px 22px;border-radius:16px}.brand{font-size:16px}h1{font-size:34px;line-height:41px;letter-spacing:-.8px}.intro{font-size:17px;line-height:25px}ul{font-size:16px;line-height:25px;margin:22px 0 26px}li{padding-left:22px;margin-bottom:9px}li:before{left:2px;top:9px}.button{font-size:18px;margin-top:22px}.note{font-size:13px;line-height:20px}.steps{font-size:15px}.back{margin-top:24px;font-size:14px}}`;

function html(env, { page, title, body, status = 200, headers = {}, turnstile = false }) {
  const nonce = crypto.randomUUID().replaceAll('-', ''), site = new URL(env.DEMO_SITE);
  const policy = `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${turnstile ? `; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com` : ''}`;
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style nonce="${nonce}">${STYLE}</style>${turnstile ? `<noscript><style nonce="${nonce}">#note{display:none}</style></noscript><script nonce="${nonce}">${START_SCRIPT}</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}</head>
<body class="${page}"><main><section class="card" aria-labelledby="title"><div class="mark" aria-hidden="true"></div><p class="brand">${escape(env.DEMO_NAME)}</p>${body}</section><nav class="back" aria-label="Return"><a href="${escape(site.origin)}/">Back to ${escape(site.host)}</a></nav></main></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': policy, 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', ...headers } });
}

/** GET /: the visitor proves they are human and their demo starts. `notice` explains a refused start. */
export function startPage(env, { status = 200, notice, headers = {} } = {}) {
  const name = escape(env.DEMO_NAME);
  return html(env, { page: 'start', title: `Try ${env.DEMO_NAME}`, status, headers, turnstile: true, body: `<h1 id="title">Try ${name}</h1>
<p class="intro">Your own copy of ${name}, signed in as its owner, with sample data.</p>
<ul><li>Public checks run live. Messages and account changes are simulated.</li><li>It ends after an hour, or 15 idle minutes.</li><li>Then it is deleted. Nobody else can see it.</li></ul>
<p class="notice" id="notice" role="alert"${notice ? '' : ' hidden'}>${notice ? escape(notice) : ''}</p><form id="start" method="post" action="/__demo/start" data-auto="${notice ? '0' : '1'}"><div class="cf-turnstile" data-sitekey="${escape(env.TURNSTILE_SITE_KEY)}" data-size="flexible" data-callback="rerDemoVerified" data-before-interactive-callback="rerDemoInteractive" data-after-interactive-callback="rerDemoChecking" data-expired-callback="rerDemoExpired" data-error-callback="rerDemoCheckFailed"></div>
<button class="button" type="submit"><span class="spinner" aria-hidden="true"></span><span class="label">Start the demo</span></button>
<ol class="steps" aria-hidden="true"><li data-at="done">Checking you're human</li><li data-at="now">Starting a private copy</li><li data-at="next">Signing you in</li></ol>
<p class="note" id="note">Complete the human check to start your demo.</p><noscript><p class="note">The human check needs JavaScript. Turn it on to start the demo.</p></noscript><p class="visually-hidden" id="status" role="status"></p></form>` });
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
