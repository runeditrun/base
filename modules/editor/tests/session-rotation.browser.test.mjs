import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { fixtureProvider } from './provider.mjs';

const { build } = await import(process.env.RER_ESBUILD_MODULE || 'esbuild');
const { chromium } = await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');
const root = fileURLToPath(new URL('..', import.meta.url));

test('copied bridge rotates authority on navigation and iframe reload, retaining compiled edits', async () => {
  const provider = await fixtureProvider();
  let server, browser;
  try {
    const bundle = await build({
      stdin: {
        contents: `import {createOwnerEditor, installCompiledLiveEdits} from './src/index.ts';
          window.editor = createOwnerEditor();
          installCompiledLiveEdits({revision:1,edits:[{id:'title',revision:1,path:'/',
            target:{selector:'main:nth-child(1) > h1:nth-child(1)',tag:'h1',role:'',beforeText:'Original'},change:{text:'Published'}}]});
          editor.setOwner(true);
          window.mounted = editor.refresh(async()=>({config:{enabled:true,
            managementOrigin:${JSON.stringify(provider.origin)},installationId:'rotation_test'},
            expiresAt:Date.now()+60000}));`,
        resolveDir: root,
      },
      bundle: true, format: 'esm', write: false,
    });
    server = createServer((request, response) => {
      response.setHeader('content-type', request.url === '/app.js' ? 'application/javascript' : 'text/html');
      response.end(request.url === '/app.js' ? bundle.outputFiles[0].text :
        '<!doctype html><title>Session rotation test</title><main><h1>Original</h1></main><script type="module" src="/app.js"></script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    provider.state.allowed = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true, ...(process.env.RER_BROWSER_CHANNEL ? {channel:process.env.RER_BROWSER_CHANNEL} : {})});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(provider.state.allowed);
    const connected = () => page.waitForFunction(() => document.querySelector('[data-rer-editor]')?.dataset.connection === 'connected');
    await connected();
    await page.getByRole('button', {name:'Open Run Edit Run', exact:true}).click();
    const frame = page.frames().find(frame => frame.url().startsWith(provider.origin));
    assert.ok(frame);
    const challenge = () => frame.evaluate(() => received.filter(message => message.type === 'protocol-connected').at(-1)?.sessionId);
    const first = await challenge();
    assert.ok(first);
    // Repeated ready is not permission to replace an already connected session.
    await frame.evaluate(() => send('ready'));
    await frame.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
    assert.equal(await challenge(), first);

    await page.evaluate(() => { history.pushState({}, '', '/next'); dispatchEvent(new PopStateEvent('popstate')); });
    await frame.waitForFunction(previous => received.some(message => message.type === 'protocol-connected' && message.sessionId !== previous), first);
    await connected();
    const second = await challenge();
    assert.notEqual(second, first);
    await frame.evaluate(stale => {
      const url = new URL(location.href);
      parent.postMessage({protocol:'rer-editor',version:1,installationId:url.searchParams.get('installation'),sessionId:stale,type:'close'}, url.searchParams.get('parentOrigin'));
    }, first);
    await frame.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
    await page.getByRole('button', {name:'Close Run Edit Run', exact:true}).waitFor();

    await frame.goto(frame.url());
    await connected();
    const third = await challenge();
    assert.ok(third);
    assert.notEqual(third, second);
    await page.evaluate(() => { history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
    await connected();
    await page.getByRole('heading', {name:'Published', exact:true}).waitFor();
    await page.evaluate(() => { editor.revoke(); editor.dispose(); editor.dispose(); });
    assert.equal(await page.locator('[data-rer-editor]').count(), 0);
    await page.getByRole('heading', {name:'Published', exact:true}).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await provider.close();
  }
});
