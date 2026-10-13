import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
/** The native root's explicit 404 component is a rendered destination too. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compiledSnapshot, notFoundCase } from './compiled-consumer-data.mjs';
import { startNativeConsumer } from './native-consumer-runtime.mjs';
const { chromium } = await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');
assert.ok(process.env.RER_NATIVE_CONSUMER_ROOT);
assert.ok(process.env.RER_EDITOR_EVIDENCE);
const root = resolve(process.env.RER_NATIVE_CONSUMER_ROOT), evidence = join(resolve(process.env.RER_EDITOR_EVIDENCE), 'notfound');
let runtime, browser;
const results = [], captures = [];
before(async () => {
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'src/editor/visual-edits.json'), 'utf8')), compiledSnapshot);
  await mkdir(evidence, { recursive: true });
  runtime = await startNativeConsumer(root, evidence);
  browser = await chromium.launch({ headless: true, ...(process.env.RER_BROWSER_CHANNEL ? { channel: process.env.RER_BROWSER_CHANNEL } : {}) });
});
after(async () => {
  await browser?.close();
  await runtime?.close();
  await writeFile(join(evidence, 'native-notfound-result.json'), JSON.stringify({
    consumerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    results, captures, ownedPort: runtime?.port,
  }, null, 2) + '\n');
});
async function published(page) {
  await page.getByRole('heading', { name: notFoundCase.after, exact: true }).waitFor({ timeout: 7000 });
  assert.equal(await page.locator('[data-rer-editor]').count(), 0);
}
test('native NotFound applies compiled edits after direct 404 hydration and reload', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    assert.equal((await page.goto(runtime.origin + notFoundCase.path)).status(), 404);
    await published(page);
    assert.equal((await page.reload()).status(), 404);
    await published(page);
    assert.deepEqual(errors, []);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const path = join(evidence, `native-notfound-${width}.jpg`);
      await page.screenshot({ path, type: 'jpeg', quality: 88 });
      captures.push({ width, path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    results.push({ operation: 'direct 404 hydration and reload', status: 'passed' });
  } finally { await page.close(); }
});
test('native router renders and resumes its NotFound leaf after history navigation', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(runtime.origin + '/records');
    await page.getByRole('heading', { name: 'Published public record', exact: true }).waitFor();
    const documentTime = await page.evaluate(() => performance.timeOrigin);
    // The browser's real history event is consumed by TanStack's native router.
    // No runtime readiness call, edit injection, or replacement applier occurs.
    await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, notFoundCase.path);
    await page.waitForURL(runtime.origin + notFoundCase.path);
    await published(page);
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentTime);
    await page.getByRole('link', { name: 'Public record', exact: true }).click();
    await page.getByRole('heading', { name: 'Published public record', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    results.push({ operation: 'native history navigation and return', status: 'passed' });
  } finally { await page.close(); }
});
