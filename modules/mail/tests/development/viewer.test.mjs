import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDevelopmentOutboxHandler } from '../../src/development/index.mjs';
import { firstLink } from '../../src/development/viewer-html.mjs';
import { createOperatorAuth } from '../../../operator-auth/index.mjs';

const origin = 'http://localhost:8787';
const row = { id: 'capture-1', createdAt: 1_790_000_000_000, message: { subject: 'Sign in <script>alert(1)</script>', to: ['Reader <reader@example.test>'], text: 'Open https://example.test/sign-in?token=abc&next=%22%3E\n<img src=x onerror=alert(1)>', html: '<script>alert(2)</script>' } };
const request = (path = '/__dev/outbox', options = {}) => new Request(`${origin}${path}`, { headers: { Host: 'localhost:8787' }, ...options });
test('outbox and operator-auth refuse doubled slashes at theme configuration', async () => {
  const auth = theme => createOperatorAuth({ db: {}, clientIp: () => '127.0.0.1', config: {
    origin, local: true, OWNER_EMAIL: 'owner@example.test',
    SESSION_SECRET: 'test-only-session-secret-at-least-32-characters', branding: { theme },
  } });
  for (const theme of ['//theme.css', '/assets//rer-theme.css', '/assets/nested//theme.css', '/assets///theme.css']) {
    const outbox = reader();
    assert.throws(() => createDevelopmentOutboxHandler({ local: true, origin, outbox, theme }), TypeError);
    assert.deepEqual(outbox.calls, []);
    assert.throws(() => auth(theme), { code: 'invalid_configuration', status: 503 });
  }
  const theme = '/assets/nested/rer-theme.css';
  const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox: reader(), theme });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(`href="${theme}"`));
  assert.equal(auth(theme).presentation.theme, theme);
});
function reader() { const calls = []; return { calls, async list() { calls.push('list'); return [row]; }, async get(id) { calls.push(id); return id === row.id ? row : null; } }; }
function headers(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  const csp = response.headers.get('content-security-policy');
  for (const directive of ["default-src 'none'", "script-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
}

test('viewer requires explicit boolean local and a canonical loopback origin before reading', async () => {
  const outbox = reader();
  for (const local of [false, undefined, 'true', 1, null]) assert.equal(await createDevelopmentOutboxHandler({ local, origin, outbox })(request()), null);
  for (const invalid of ['https://example.test', 'http://localhost.evil:8787', 'http://localhost:8787/', 'http://localhost:8787/a', 'http://localhost:8787?', 'http://localhost:8787#', 'http://a@localhost:8787', ' http://localhost:8787', 'http://LOCALHOST:8787', 'http://127.1:8787', 'http://2130706433:8787', 'http://localhost:08787', 'http://localhost:80', 'ftp://localhost:8787', '', null]) {
    assert.equal(await createDevelopmentOutboxHandler({ local: true, origin: invalid, outbox })(request()), null, String(invalid));
  }
  assert.deepEqual(outbox.calls, []);
});

test('URL and Host authority and port must independently agree; forwards never admit a request', async () => {
  const outbox = reader(); const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox });
  for (const host of [undefined, 'example.test', 'localhost', 'localhost:80', 'localhost:8788', 'LOCALHOST:8787', 'localhost:8787, example.test', 'user@localhost:8787']) {
    const supplied = host === undefined ? {} : { Host: host };
    const response = await handler(new Request(`${origin}/__dev/outbox`, { headers: { ...supplied, Forwarded: 'host=localhost:8787;proto=http', 'X-Forwarded-Host': 'localhost:8787', 'X-Forwarded-Proto': 'http' } }));
    assert.equal(response, null, String(host));
  }
  for (const url of ['https://example.test/__dev/outbox', 'https://localhost:8787/__dev/outbox', 'http://localhost:8788/__dev/outbox', 'http://127.0.0.1:8787/__dev/outbox']) assert.equal(await handler(new Request(url, { headers: { Host: 'localhost:8787' } })), null);
  for (const path of ['/__dev/outbox/extra', '/__dev/outbox/', '/%5f%5fdev/outbox']) assert.equal(await handler(request(path)), null);
  for (const supplied of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal(await handler(request('/__dev/outbox', { headers: { Host: 'localhost:8787', ...supplied } })), null);
  }
  assert.deepEqual(outbox.calls, []);
  assert.equal((await handler(request('/__dev/outbox', { headers: { Host: 'localhost:8787', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https' } }))).status, 200);
});

test('canonical IPv4 and IPv6 loopback and explicit custom route work', async () => {
  for (const origin of ['http://127.0.0.1:8787', 'https://127.12.3.4', 'http://[::1]:8787', 'http://localhost']) {
    const outbox = reader(); const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox, path: '/local/mail' });
    assert.equal((await handler(new Request(`${origin}/local/mail`, { headers: { Host: new URL(origin).host } }))).status, 200);
  }
  for (const path of ['//evil.test', '/x?y', '/x#z', '/x%2fy', '/x/../outbox', 'outbox']) assert.equal(await createDevelopmentOutboxHandler({ local: true, origin, outbox: reader(), path })(request()), null);
});

test('list and detail escape hostile content, preserve plain metadata and show safe action', async () => {
  const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox: reader() });
  const list = await handler(request()); headers(list); const listBody = await list.text();
  assert.match(listBody, /Sign in &lt;script&gt;/); assert.match(listBody, /To: Reader &lt;reader@example.test&gt;/); assert.match(listBody, /Received: <time/);
  assert.match(listBody, /Read message/); assert.doesNotMatch(listBody, /token=abc|<script>/);
  const response = await handler(request('/__dev/outbox?message=capture-1')); headers(response);
  const html = await response.text();
  assert.match(html, /class="open" href="https:\/\/example.test\/sign-in\?token=abc&amp;next=%22%3E"/);
  assert.match(html, />Open this link<\/a>/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img|onerror="/);
  const css = html.match(/<style>(.*?)<\/style>/s)[1];
  assert.ok(response.headers.get('content-security-policy').includes(`'sha256-${createHash('sha256').update(css).digest('base64')}'`));
  assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /white-space:pre-wrap/); assert.match(css, /min-height:56px/); assert.match(html, /width=device-width/);
});

test('HTML-only mail is escaped source, with its first safe HTTP link as the action', async () => {
  const htmlRow = { ...row, message: { ...row.message, text: undefined, html: '<p>Link <a href="https://example.test/start?a=1&amp;b=2">Enter</a></p><img src=x onerror=alert(1)>' } };
  const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox: { async list() { return []; }, async get() { return htmlRow; } } });
  const response = await handler(request('/__dev/outbox?message=html')); const html = await response.text();
  assert.match(html, /href="https:\/\/example.test\/start\?a=1&amp;b=2"/);
  assert.match(html, /&lt;p&gt;Link &lt;a/); assert.doesNotMatch(html, /<img/);
  assert.equal(firstLink({ text: 'javascript:alert(1) data:text/html,test //example.test' }), null);
  assert.equal(firstLink({ text: 'https://user:fake-password@example.test https:// https://good.test/first https://good.test/second' }), 'https://good.test/first');
  assert.equal(firstLink({ text: 'http://good.test/ok', html: '<a href="https://later.test">later</a>' }), 'http://good.test/ok');
});

test('empty, absent, invalid, failing and method responses retain secure headers', async () => {
  const outbox = reader(); const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox });
  for (const [path, status] of [['/__dev/outbox?message=absent', 404], ['/__dev/outbox?message=', 400], ['/__dev/outbox?message=x&message=y', 400], ['/__dev/outbox?unexpected=1', 400]]) {
    const response = await handler(request(path)); assert.equal(response.status, status); headers(response);
  }
  const post = await handler(request('/__dev/outbox', { method: 'POST' })); assert.equal(post.status, 405); headers(post); assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const head = await handler(request('/__dev/outbox', { method: 'HEAD' })); assert.equal(head.status, 200); assert.equal(await head.text(), ''); headers(head);
  const failed = createDevelopmentOutboxHandler({ local: true, origin, outbox: { async list() { throw new Error('SECRET'); }, async get() { throw new Error('SECRET'); } } });
  for (const path of ['/__dev/outbox', '/__dev/outbox?message=id']) { const response = await failed(request(path)); assert.equal(response.status, 503); headers(response); assert.doesNotMatch(await response.text(), /SECRET/); }
  const empty = createDevelopmentOutboxHandler({ local: true, origin, outbox: { async list() { return []; }, async get() { return null; } } });
  assert.match(await (await empty(request())).text(), /No messages yet/);
});

test('a declared theme links the seed stylesheet under the themed policy; unsafe paths are refused; no theme stays plain', async () => {
  const plain = await (await createDevelopmentOutboxHandler({ local: true, origin, outbox: reader() }))(request());
  const plainHtml = await plain.text();
  assert.doesNotMatch(plainHtml, /rer-themed|<link/); assert.doesNotMatch(plain.headers.get('content-security-policy'), /'self'|font-src|img-src/);
  const handler = createDevelopmentOutboxHandler({ local: true, origin, outbox: reader(), theme: '/rer-theme.css' });
  for (const path of ['/__dev/outbox', '/__dev/outbox?message=capture-1']) {
    const response = await handler(request(path)); headers(response); const html = await response.text();
    assert.match(html, /^<!doctype html><html lang="en" class="rer-themed">/); assert.match(html, /<link rel="stylesheet" href="\/rer-theme\.css">/);
    assert.doesNotMatch(html, /<script|<[^>]*\son[a-z]+=/i);
    const css = html.match(/<style>(.*?)<\/style>/s)[1], csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes(`style-src 'self' 'sha256-${createHash('sha256').update(css).digest('base64')}'; font-src 'self'; img-src 'self'`));
    assert.match(css, /outline:3px solid var\(--rer-focus,#[0-9a-f]{3,6}\)/);
  }
  for (const theme of ['rer-theme.css', '//evil.test/x.css', 'https://evil.test/x.css', '/a/../x.css', '/.hidden.css', '/x.css?v=1', '/x.js', '', 7, null]) {
    assert.throws(() => createDevelopmentOutboxHandler({ local: true, origin, outbox: reader(), theme }), TypeError);
  }
});
