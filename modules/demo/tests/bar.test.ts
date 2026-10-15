import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = new URL('../../', import.meta.url);

// A seed Worker wrapped by withDemo, through its fetch door in workerd, with
// and without RER_DEMO. The only send it makes is refused by the guard itself.
async function worker(t, bindings) {
  const modules = ['demo/tests/fixture.mjs', 'demo/index.mjs', ...['http', 'csp', 'errors', 'crypto', 'loopback'].map(name => `operator-auth/${name}.mjs`)];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(ROOT), modules: modules.map(path => ({ type: 'ESModule', path: fileURLToPath(new URL(path, ROOT)) })), compatibilityDate: '2026-09-08', d1Databases: { DB: 'demo' }, bindings }));
  t.after(() => mf.dispose());
  return async path => { const response = await mf.dispatchFetch(`http://127.0.0.1${path}`); return { response, text: await response.text() }; };
}
const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

test('under RER_DEMO every HTML page opens with the Demo bar, allowed by its CSP, and lists what was refused', async t => {
  const get = await worker(t, { RER_DEMO: '1' });
  const { response, text } = await get('/');
  assert.match(text, /<body class="app"><style>[^<]+<\/style><aside id="rer-demo-bar" aria-label="Demo">/, 'the bar opens the body');
  assert.match(text, /<\/aside><header>App header<\/header>/, 'the page follows it unchanged');
  const style = /<style>([^<]+)<\/style>/.exec(text)[1];
  assert.ok(response.headers.get('content-security-policy').includes(hash(style)), "the bar's style is allowed by hash");
  assert.doesNotMatch(/<aside id="rer-demo-bar"[\s\S]*?<\/aside>/.exec(text)[0], /hooks\.example\.com/);

  assert.match((await get('/send')).text, /refused/, 'a send out is refused');
  const after = /<aside id="rer-demo-bar"[\s\S]*?<\/aside>/.exec((await get('/')).text)[0];
  assert.match(after, /<li>POST hooks\.example\.com<\/li>/, 'the refused send is listed');

  const json = await get('/json');
  assert.deepEqual(JSON.parse(json.text), { ok: true }, 'non-HTML responses are untouched');
});

test('without RER_DEMO the Worker is unchanged: no bar, no style, the same CSP', async t => {
  const get = await worker(t, {});
  const { response, text } = await get('/');
  assert.equal(text, '<!doctype html><html><head><title>App</title></head><body class="app"><header>App header</header></body></html>');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'self'");
});
