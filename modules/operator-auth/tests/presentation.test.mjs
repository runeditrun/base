import { conformanceGroups } from './conformance-cases.mjs';
import { runCases } from './cases.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { configure } from '../config.mjs';
import { createOperatorAuth } from '../index.mjs';
import { confirmationResponse } from '../identity/email-link/confirmation.mjs';
import { securityHeaders } from '../http.mjs';
import { linkMessage } from '../identity/email-link/message.mjs';
import { runtime, presets } from '../identity/oidc/tests/fake-runtime.mjs';

const base = { origin: 'https://auth.test', OWNER_EMAIL: 'owner@example.com', SESSION_SECRET: 'test-only-session-secret-at-least-32-characters' };
const branding = { productName: '<A & "B">', accentColor: '#fffFFF', signInPath: '/signin?next=%2Fapp&from=auth' };

test('branding validates all optional fields and snapshots only public presentation', async t => {

  await runCases(t, [
['default public branding', async t => {
  assert.deepEqual(configure(base).branding, { productName: 'your workspace', accentColor: '#334155', signInPath: '/signin' });
}],
['invalid public branding variants', async t => {
  await runCases(t, Array.from([null, [], '', 1, true, { productName: '' }, { productName: '   ' }, { productName: 1 }, { productName: 'a'.repeat(81) }, { productName: 'a\nB' }, { productName: 'a\u0085B' }, { accentColor: '#fff' }, { accentColor: 'red' }, { accentColor: '#112233; color:red' }, { accentColor: null }, { signInPath: null }, ...['//evil.test', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)', '/\nroute', '/%2fevil.test', '/%252fevil.test', '/%5cevil.test', '/%00', '/%zz', '/%25250a'].map(signInPath => ({ signInPath }))], (invalid, rowIndex) => [`${t.name}: invalid row ${rowIndex + 1}`, async t => {
    assert.throws(() => configure({ ...base, branding: invalid }), { code: 'invalid_configuration', status: 503 });
}]));
}],
['immutable public branding snapshot', async t => {
  const input = { ...branding, SESSION_SECRET: 'test-must-not-copy-extra-fields' };
  const auth = createOperatorAuth({ db: {}, config: { ...base, branding: input }, clientIp: () => '192.0.2.1' });
  assert.deepEqual(auth.presentation, branding);
  input.productName = 'Changed';
  assert.equal(auth.presentation.productName, branding.productName);
  assert.ok(Object.isFrozen(auth.presentation));
  assert.throws(() => { auth.presentation.productName = 'Changed'; }, TypeError);
}],
['maximum product name boundary', async t => {
  assert.equal(configure({ ...base, branding: { productName: 'a'.repeat(80), signInPath: '/signin?q=one%20two#start' } }).branding.productName.length, 80);
}]
  ]);
});

test("product names preserve visible Unicode while refusing unsafe or misplaced scalars", async t => {
  const foldedCases = [];
foldedCases.push(['product names reject every forbidden control scalar and preserve normal Unicode', async (t) => {
  await runCases(t, Array.from([[0x0000, 0x001f], [0x007f, 0x009f], [0x061c, 0x061c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff]], ([first, last], rowIndex) => [`${t.name}: [first, last] row ${rowIndex + 1}`, async t => {
    for (let code = first; code <= last; code++) {
      await runCases(t, [[`${t.name} > U+${code.toString(16)}`, async () => {
        // ZWNJ and ZWJ are valid between letters, so those two are checked in a position where they never are.
        const joiner = code === 0x200c || code === 0x200d;
        const productName = joiner ? `Workspace ${String.fromCodePoint(code)} Name` : `Workspace${String.fromCodePoint(code)}Name`;
        assert.throws(() => configure({ ...base, branding: { productName } }), { code: 'invalid_configuration', status: 503 }, `U+${code.toString(16)}`);
      }]]);
    }
}]));
  await runCases(t, Array.from(['Café', 'Cafe\u0301', '日本語のワークスペース', 'مساحة العمل', 'שלום', 'Workspace 🚀'], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.equal(configure({ ...base, branding: { productName } }).branding.productName, productName);
}]));
}]);
foldedCases.push(['product names preserve script joiners and emoji presentation', async (t) => {
  await runCases(t, Array.from([
    'می\u200cخواهم', 'क्\u200dष', 'क्\u200cष', 'مساحة العمل', 'שלום', '中文工作区',
    '👨\u200d👩\u200d👧', '👩🏽\u200d💻', '❤️', '🏳️\u200d🌈',
    'Workspace\u200cName', 'Workspace\u200dName', '123', '!?', '🚀', '1️⃣', '⠁⠀⠃',
  ], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.equal(configure({ ...base, branding: { productName } }).branding.productName, productName);
}]));
}]);
foldedCases.push(['product names reject invisible scalars and misplaced joiners or variation selectors', async (t) => {
  await runCases(t, Array.from([
    [0x00ad, 0x00ad], [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5],
    [0x180b, 0x180f], [0x2065, 0x2065], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
    [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xffa0, 0xffa0], [0xe0100, 0xe01ef],
  ], ([first, last], rowIndex) => [`${t.name}: [first, last] row ${rowIndex + 1}`, async t => {
    for (let code = first; code <= last; code++) {
      await runCases(t, [[`${t.name} > U+${code.toString(16)}`, async () => {
        assert.throws(() => configure({ ...base, branding: { productName: `Workspace${String.fromCodePoint(code)}Name` } }),
          { code: 'invalid_configuration', status: 503 }, `U+${code.toString(16)}`);
      }]]);
    }
}]));
  await runCases(t, Array.from([
    '\u200cName', 'Name\u200d', 'a\u200c\u200db', '🚀\u200c🚀', 'a\u200d🚀', '🚀\u200da',
    '\ufe0f❤️', '❤️\ufe0f', '❤\ufe0e', ' \u00a0\u1680\u2000\u202f\u205f\u3000 ', ' \u2800 ',
    '\u200c\u200d', '\u0301\u093e', '\u115f\u1160\u3164\uffa0',
  ], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.throws(() => configure({ ...base, branding: { productName } }), { code: 'invalid_configuration', status: 503 });
}]));
}]);
foldedCases.push(['product names allow emoji presentation only on pictographs and keycaps, and reject placeholders and broken text', async (t) => {
  await runCases(t, Array.from(['#\ufe0f\u20e3', '*\ufe0f\u20e3', '0\ufe0f\u20e3 Team', '\u00a9\ufe0f Studio', '\u2764\ufe0f'], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.equal(configure({ ...base, branding: { productName } }).branding.productName, productName);
}]));
  await runCases(t, Array.from([
    'Name1\ufe0f', '1\ufe0f', '#\ufe0f', '*\ufe0f', 'Team #\ufe0f', '1\ufe0f\u20e3\ufe0f',
    '\ufffc', 'Name\ufffc', '\ufffc\ufffc',
    'a\ud800', '\udc00b', 'Name\ud83d', '\ud83dName',
  ], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.throws(() => configure({ ...base, branding: { productName } }), { code: 'invalid_configuration', status: 503 }, JSON.stringify(productName));
}]));
}]);
foldedCases.push(['product names keep word-final chillu and Persian ZWNJ before spaces or digits', async (t) => {
  await runCases(t, Array.from([
    '\u0d15\u0d47\u0d30\u0d33\u0d24\u0d4d\u0d24\u0d3f\u0d32\u0d4d\u200d', '\u0d05\u0d35\u0d7c \u0d2a\u0d23\u0d4d\u200d \u0d15\u0d1f',
    '\u0915\u094d\u200d', '\u06a9\u062a\u0627\u0628\u200c \u0647\u0627', '\u0633\u0627\u0644\u200c\u06f1\u06f4\u06f0\u06f0',
  ], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.equal(configure({ ...base, branding: { productName } }).branding.productName, productName);
}]));
  await runCases(t, Array.from([
    'Name\u200c ', 'Name\u200c', 'Name\u200c!', 'Name\u200d 1', 'a\u200d', '\u0915\u094d\u200d\u200d', '\u094d\u200d', 'Name \u200c\u0627',
  ], (productName, rowIndex) => [`${t.name}: productName row ${rowIndex + 1}`, async t => {
    assert.throws(() => configure({ ...base, branding: { productName } }), { code: 'invalid_configuration', status: 503 }, JSON.stringify(productName));
}]));
}]);
  await runCases(t, foldedCases);
});









test('mail provides a self-contained reading layout and describes navigation before confirmation', async (t) => {
  await runCases(t, Array.from(['magic', 'invite'], (kind, rowIndex) => [`${t.name}: kind row ${rowIndex + 1}`, async t => {
    const config = configure({ ...base, branding, linkSeconds: 1200 });
    const url = 'https://auth.test/auth/confirm?token=test-only-mail-token';
    const message = linkMessage(config, { kind }, url);
    const action = kind === 'invite' ? 'accept your invitation to' : 'sign in to';
    assert.ok(message.text.includes(`Open this link to review and confirm. On the confirmation page, press Confirm to ${action} ${branding.productName}.`));
    assert.match(message.html, /<body style="margin:0;font-family:Arial,sans-serif;background:#fff;color:#172033"><main style="max-width:480px;margin:0 auto;padding:32px 24px">/);
    assert.match(message.html, />Confirm<\/a>/);
    assert.ok(message.html.includes(`Open this link to review and confirm. On the confirmation page, press Confirm to ${action} &lt;A &amp; &quot;B&quot;&gt;.`));
    assert.ok(!message.html.includes(branding.productName));
    assert.equal((message.html.match(/<a /g) ?? []).length, 1);
    assert.equal((message.html.match(/https?:\/\//g) ?? []).length, 1);
    assert.doesNotMatch(message.html, /<script|<img|<link|<iframe|url\s*\(|@import/i);
}]));
});

test('branding preserves encoded percent data while inspecting nested unsafe encodings', async (t) => {
  await runCases(t, [['encoded branding scenarios', async t => {
  await runCases(t, Array.from([
    '/search?q=%25',
    '/signin?next=%2Fapp%3Fdiscount%3D100%2525',
    '/search?q=%25ab&currency=%25E2%2582%25AC',
    '/search?q=%25zz#100%25',
  ], (signInPath, rowIndex) => [`${t.name}: valid encoded path row ${rowIndex + 1}`, async t => {
    assert.equal(configure({ ...base, branding: { signInPath } }).branding.signInPath, signInPath);
}]));
  await runCases(t, Array.from([
    '/%252fevil.test?q=%25',
    '/%25%2532%2566evil.test?q=%25',
    '/signin?q=%25&next=%255capp',
    '/signin?q=%25&next=%25250a',
    '/signin?q=%25ab%250a',
    '/signin?q=%25ab%25C2%2585',
    '/signin?q=%25&next=%257f',
    '/signin?q=%25&next=%25C2%259F',
    '/signin?q=%',
    '/signin?q=%2',
    '/signin?q=%ab',
  ], (signInPath, rowIndex) => [`${t.name}: unsafe encoded path row ${rowIndex + 1}`, async t => {
    assert.throws(() => configure({ ...base, branding: { signInPath } }), { code: 'invalid_configuration', status: 503 }, signInPath);
}]));

  }]]);
});

test('HTML confirmation has one exact-byte stylesheet hash and a minimal credential footprint', async t => {
  await runCases(t, [['confirmation footprint scenarios', async t => {
  await runCases(t, Array.from(['#ffffff', '#000000', '#336699'], (accentColor, rowIndex) => [`${t.name}: accentColor row ${rowIndex + 1}`, async t => {
    await runCases(t, Array.from([{ kind: 'magic', expiresInMinutes: 15 }, { kind: 'invite', expiresInMinutes: 1 }, null], (preview, rowIndex) => [`${t.name}: preview row ${rowIndex + 1}`, async t => {
      const token = 'test-only-opaque-token';
      const response = await confirmationResponse({ branding: { ...branding, accentColor }, preview, token, method: 'GET' });
      const html = await response.text();
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
      assert.equal(styles.length, 1);
      const hash = createHash('sha256').update(styles[0][1]).digest('base64');
      assert.equal(response.headers.get('Content-Security-Policy'), `${securityHeaders()['Content-Security-Policy']}; style-src 'sha256-${hash}'`);
      assert.notEqual(createHash('sha256').update(`${styles[0][1]} `).digest('base64'), hash);
      assert.doesNotMatch(html, /<script|<img|<link|style=|url\s*\(|@import|https?:\/\//i);
      assert.match(html, /&lt;A &amp; &quot;B&quot;&gt;/);
      assert.equal(html.split(token).length - 1, preview ? 1 : 0);
      assert.equal(response.headers.get('set-cookie'), null);
      if (preview) {
        assert.match(html, new RegExp(`<h1>${preview.kind === 'invite' ? 'Accept your invitation to' : 'Confirm sign-in to'}`));
        assert.match(html, /<input type="hidden" name="token"/);
        assert.match(html, /<button type="submit">Confirm<\/button>/);
        assert.match(html, new RegExp(`This link works once and expires in ${preview.expiresInMinutes} minute`));
      } else {
        assert.equal(response.status, 400);
        assert.match(html, /href="\/signin\?next=%2Fapp&amp;from=auth">Request a new link/);
      }
      const head = await confirmationResponse({ branding: { ...branding, accentColor }, preview, token, method: 'HEAD' });
      assert.equal(await head.text(), '');
      assert.equal(head.status, response.status);
      assert.deepEqual([...head.headers], [...response.headers]);
}]));
}]));
  await runCases(t, conformanceGroups.presentation);

  }]]);
});

test('a declared seed theme links its served stylesheet and the CSP admits only same-origin theme files', async t => {

await runCases(t, [
['invalid seed theme variants', async t => {

  await runCases(t, Array.from(['//evil.test/x.css', 'https://evil.test/x.css', '/x.js', '/a/../x.css', '/.x.css', '/x.css?y', '/x".css', 1], (theme, rowIndex) => [`${t.name}: theme row ${rowIndex + 1}`, async t => {
    assert.throws(() => configure({ ...base, branding: { theme } }), { code: 'invalid_configuration', status: 503 });
}]));
}],
['served seed theme and policy', async t => {

  const themed = configure({ ...base, branding: { ...branding, theme: '/rer-theme.css' } }).branding;
  assert.equal(themed.theme, '/rer-theme.css');
  const response = await confirmationResponse({ branding: themed, preview: { kind: 'magic', expiresInMinutes: 15 }, token: 'test-only-opaque-token', method: 'GET' });
  const html = await response.text();
  assert.match(html, /<html lang="en" class="rer-themed">/);
  assert.match(html, /<link rel="stylesheet" href="\/rer-theme.css">/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const hash = createHash('sha256').update(style).digest('base64');
  assert.equal(response.headers.get('Content-Security-Policy'), `${securityHeaders()['Content-Security-Policy']}; style-src 'self' 'sha256-${hash}'; font-src 'self'; img-src 'self'`);
}]
]);
});

test('the owner sign-in settings page wears the declared seed theme, as sign-in does', async t => {
  const setup = presets();
  setup.core = { ...setup.core, branding: { productName: 'Fixture', theme: '/rer-theme.css' } };
  const r = await runtime(t, setup);
  const owner = await r.bootstrap();
  const page = await r.call('/auth/settings/identity', { cookie: owner, headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html lang="en" class="rer-themed">/);
  assert.match(html, /<link rel="stylesheet" href="\/rer-theme.css">/);
  assert.match(html, /<form action="\/auth\/settings\/identity" method="post">/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(page.headers.get('Content-Security-Policy'), new RegExp(`style-src 'self' 'sha256-${createHash('sha256').update(style).digest('base64').replace(/[+/]/g, '\\$&')}'`));
});
