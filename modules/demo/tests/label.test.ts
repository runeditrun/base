import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decorateLabel } from '../label.mjs';

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

test('demo and dev titles stay singular through empty titles, mode switches and head mutations', async () => {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const decorated = await decorateLabel(new Response(`<head><title>${url.searchParams.get('title') ?? ''}</title></head><body></body>`, {
      headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'none'" },
    }), url.searchParams.get('mode'));
    response.writeHead(decorated.status, Object.fromEntries(decorated.headers));
    response.end(await decorated.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const cases = [['', ''], ['Demo', ''], ['Dev', ''], [' Demo', ''], ['\tDev', ''], ['Workspace', 'Workspace'], ['Workspace\tDemo', 'Workspace'], ['Workspace\nDev', 'Workspace']];
    for (const mode of ['Demo', 'Dev']) {
      for (const [input, base] of cases) {
        const expected = base ? `${base} ${mode}` : mode;
        const url = `${origin}/?${new URLSearchParams({ mode, title: input })}`;
        const html = await (await fetch(url)).text();
        assert.equal(html.match(/<title>(.*?)<\/title>/s)?.[1], expected, 'server title has one suffix and no empty-name separator');
        await page.goto(url);
        assert.equal(await page.title(), expected);
        await page.evaluate(title => { document.title = title; }, input);
        await page.waitForFunction(title => document.title === title, expected);
        // A head manager may mutate unrelated elements after setting a title.
        // Allow both the observer and another browser turn to run before checking.
        await page.evaluate(async () => {
          document.head.append(document.createElement('meta'));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        assert.equal(await page.title(), expected, 'head mutations preserve the single suffix');
      }
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
