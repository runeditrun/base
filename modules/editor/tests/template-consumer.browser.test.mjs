import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startNativeConsumer } from './native-consumer-runtime.mjs';
import { compiledSnapshot } from './compiled-consumer-data.mjs';
const { chromium } = await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');
let runtime, browser;
before(async () => {
  runtime = await startNativeConsumer(process.env.RER_NATIVE_CONSUMER_ROOT, join(process.env.RER_EDITOR_EVIDENCE, 'template'));
  browser = await chromium.launch({ headless: true, ...(process.env.RER_BROWSER_CHANNEL ? { channel: process.env.RER_BROWSER_CHANNEL } : {}) });
});
after(async () => { await browser?.close(); await runtime?.close(); });
for (const width of [1440, 390]) test(`native template negotiates v1, edits and rejects stale frame at ${width}`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await runtime.login(page);
    await page.goto(runtime.origin + '/app');
    await page.getByRole('button', { name: 'Open Run Edit Run', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-rer-editor]')?.dataset.connection === 'connected');
    const frame = page.frames().find(frame => frame.url().startsWith(runtime.provider.origin));
    const first = await frame.evaluate(() => received.findLast(message => message.type === 'protocol-connected'));
    assert.equal(first.protocol, 'rer-editor');
    assert.equal(first.version, 1);
    assert.match(first.sessionId, /^[a-zA-Z0-9_-]{16,100}$/);
    const original = compiledSnapshot.edits.find(edit => edit.path === '/app');
    const snapshot = { revision: 10, edits: [{ ...original, id: 'template', revision: 10,
      parentOrigin: runtime.origin, change: { text: `Edited at ${width}` } }] };
    await frame.evaluate(snapshot => send('live-edits', { snapshot }), snapshot);
    await page.getByRole('heading', { name: `Edited at ${width}`, exact: true }).waitFor();
    await frame.waitForFunction(() => received.some(message => message.type === 'live-edit-result' && message.id === 'template' && message.status === 'applied'));
    await frame.goto(frame.url());
    await frame.waitForFunction(() => received.some(message => message.type === 'protocol-connected'));
    const second = await frame.evaluate(() => received.findLast(message => message.type === 'protocol-connected'));
    assert.notEqual(second.sessionId, first.sessionId);
    const stale = { ...snapshot, revision: 11, edits: snapshot.edits.map(edit => ({ ...edit, revision: 11, change: { text: 'Stale frame edit' } })) };
    await frame.evaluate(({ first, snapshot }) => {
      parent.postMessage({ ...first, type: 'live-edits', snapshot }, new URL(location.href).searchParams.get('parentOrigin'));
    }, { first, snapshot: stale });
    // A following valid operation is a message-order barrier and proves the new frame remains useful.
    await frame.evaluate(snapshot => send('live-edits', { snapshot }), { ...snapshot, revision: 12,
      edits: snapshot.edits.map(edit => ({ ...edit, revision: 12, change: { text: `Fresh at ${width}` } })) });
    await page.getByRole('heading', { name: `Fresh at ${width}`, exact: true }).waitFor();
    assert.equal(await frame.evaluate(() => received.some(message => message.type === 'live-edit-result' && message.revision === 11)), false);
    assert.equal(await page.getByRole('heading', { name: 'Stale frame edit', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
