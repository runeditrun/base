import { createMailSender } from '../../../mail/index.mjs';
import { createD1DevelopmentOutbox, createDevelopmentOutboxHandler } from '../../../mail/src/development/index.mjs';

function document(title, body, script = '', style = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui;color:#17212e;background:white}main{max-width:48rem;margin:auto;padding:24px 16px}a{color:#174fb5}input,button{font:inherit;display:block;margin:12px 0;padding:12px;max-width:100%}button{background:#174fb5;color:white;border:0}:focus-visible{outline:3px solid #17212e;outline-offset:3px}${style}</style></head><body><main><h1>${title}</h1>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      try { await env.DB.prepare('SELECT value FROM fixture_setup LIMIT 1').all(); }
      catch { return new Response('starting', { status: 503 }); }
      return new Response('health', { status: Date.now() >= Number(env.HEALTH_AFTER) ? 200 : 503 });
    }
    const outbox = createD1DevelopmentOutbox({ db: env.DB });
    const view = createDevelopmentOutboxHandler({ local: true, origin: env.ORIGIN, outbox });
    const response = await view(request);
    if (response) return response;
    if (url.pathname === '/__fixtures/setup') {
      await env.DB.prepare('INSERT INTO fixture_setup(value) VALUES (?)').bind('synthetic').run();
      return new Response('ready');
    }
    if (url.pathname === '/__fixtures/mail' && request.method === 'POST') {
      const input = await request.json();
      await outbox.put({ deliveryId: crypto.randomUUID(), from: 'auth@example.test', to: [input.email], subject: 'Fixture message', text: input.link });
      if (input.createdAt) await env.DB.prepare('UPDATE rer_mail_development_outbox SET created_at = ? WHERE sequence = (SELECT MAX(sequence) FROM rer_mail_development_outbox)').bind(input.createdAt).run();
      return new Response('stored');
    }
    if (url.pathname === '/signin') return html(document('Sign in', '<form method="post" action="/auth/request"><label for="email">Email</label><input id="email" name="email" type="email" required><button>Email a sign-in link</button></form>'));
    if (url.pathname === '/auth/request' && request.method === 'POST') {
      const email = (await request.formData()).get('email');
      if (email !== 'missing@example.test') {
        const token = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO fixture_links(token, email) VALUES (?, ?)').bind(token, email).run();
        await createMailSender({ provider: 'development', mode: 'development' }, { outbox }).send({ deliveryId: crypto.randomUUID(), from: 'auth@example.test', to: [email], subject: 'Sign in', text: `${env.ORIGIN}/auth/confirm?token=${token}` });
      }
      return html(document('Check your email', '<p role="status">Your sign-in message is ready.</p><a href="/signin">Back to sign in</a>'));
    }
    if (url.pathname === '/auth/confirm') {
      const row = await env.DB.prepare('SELECT email FROM fixture_links WHERE token = ?').bind(url.searchParams.get('token')).first();
      if (!row) return html(document('Invalid link', '<a href="/signin">Try again</a>'), 400);
      await env.DB.prepare('DELETE FROM fixture_links WHERE token = ?').bind(url.searchParams.get('token')).run();
      return new Response(null, { status: 303, headers: { Location: '/app', 'Set-Cookie': 'fixture-session=signed-in; HttpOnly; SameSite=Lax; Path=/' } });
    }
    if (url.pathname === '/app') {
      if (!request.headers.get('cookie')?.includes('fixture-session=signed-in')) return new Response(null, { status: 303, headers: { Location: '/signin' } });
      return html(document('Your workspace', '<p>You are signed in.</p><a href="/signin">Sign in page</a>'));
    }
    const link = '<a href="/signin">Sign in page</a>';
    if (url.pathname === '/slow-image') {
      await new Promise(resolve => setTimeout(resolve, 700));
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
    }
    if (url.pathname === '/network') return html(document('Loading resource', `<img alt="" src="/slow-image">${link}`));
    if (url.pathname === '/clean') return html(document('Clean page', link));
    if (url.pathname === '/defects/axe') return html(document('Low contrast text', `<p style="color:#aaa">This text has insufficient contrast.</p>${link}`));
    if (url.pathname === '/defects/overflow') return html(document('Wide page', `<div class="wide">Wide content</div>${link}`, '', '@media(max-width:500px){.wide{width:800px}}'));
    if (url.pathname === '/defects/external') return html(document('Foreign request', link, `fetch('${env.EXTERNAL}/resource').catch(()=>{})`));
    if (url.pathname === '/defects/page-error') return html(document('Script failure', link, 'throw new Error("synthetic page failure")'));
    if (url.pathname === '/defects/console-error') return html(document('Console failure', link, 'console.error("synthetic console failure")'));
    if (url.pathname === '/defects/hydration') return html(document('Hydration failure', link, 'console.warn("Hydration did not match")'));
    if (url.pathname === '/defects/subresource') return html(document('Missing resource', `${link}<script src="/missing.js"></script>`));
    if (url.pathname === '/defects/secret') return html(document('Visible credential', `<p>${env.SYNTHETIC_SECRET}</p>${link}`));
    if (url.pathname === '/defects/keyboard') return html(document('No actions', '<p>This page has no focusable element.</p>'));
    if (url.pathname === '/defects/focus-visible') return html(document('Hidden focus', link, '', ':focus-visible{outline:none}'));
    if (url.pathname === '/data-blob') return html(document('Local browser data', link, `const image=new Image();image.alt='Blank';image.src=URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'],{type:'image/svg+xml'}));document.querySelector('main').append(image)`));
    if (url.pathname === '/settle') return html(document('Settling page', `<div id="busy" aria-busy="true">Waiting</div><div id="animated">Animation</div>${link}`, `document.getElementById('animated').animate([{opacity:0},{opacity:1}],{duration:800}).finished.then(()=>document.getElementById('animated').dataset.finished='yes');setTimeout(()=>{document.getElementById('busy').removeAttribute('aria-busy');document.getElementById('busy').textContent='Ready'},700)`));
    if (url.pathname === '/busy') return html(document('Busy page', `<div aria-busy="true">Waiting</div>${link}`));
    return html(document('Page not found', link), 404);
  },
};
