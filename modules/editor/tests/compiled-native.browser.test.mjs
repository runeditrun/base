import {queuedEntrypoint} from '../../../onboarding/queued-entry.mjs';
const queued=await queuedEntrypoint(import.meta.url,'verify:editor-browser');if(queued!==null)process.exit(queued);
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compiledCases, compiledSnapshot } from './compiled-consumer-data.mjs';
import { startNativeConsumer } from './native-consumer-runtime.mjs';
const { chromium } = await import(process.env.RER_PLAYWRIGHT_MODULE || '@playwright/test');
assert.ok(process.env.RER_NATIVE_CONSUMER_ROOT, 'Set RER_NATIVE_CONSUMER_ROOT to the built nonempty native consumer/default-seed');
assert.ok(process.env.RER_EDITOR_EVIDENCE, 'Set an external RER_EDITOR_EVIDENCE directory');
const root = resolve(process.env.RER_NATIVE_CONSUMER_ROOT);
const evidence = resolve(process.env.RER_EDITOR_EVIDENCE);
let runtime, browser;
const results = [], captures = [];
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
before(async () => {
  assert.equal(git(['status', '--porcelain']), '', 'native consumer source must be committed and clean');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'src/editor/visual-edits.json'), 'utf8')), compiledSnapshot);
  await mkdir(evidence, { recursive: true });
  runtime = await startNativeConsumer(root, evidence);
  browser = await chromium.launch({ headless: true, ...(process.env.RER_BROWSER_CHANNEL ? { channel: process.env.RER_BROWSER_CHANNEL } : {}) });
});
after(async () => {
  await browser?.close();
  await runtime?.close();
  await writeFile(join(evidence, 'compiled-native-result.json'), JSON.stringify({
    consumerRevision: git(['rev-parse', 'HEAD']), source: JSON.parse(await readFile(join(root, '../SOURCE.json'), 'utf8')),
    snapshotSha256: createHash('sha256').update(await readFile(join(root, 'src/editor/visual-edits.json'))).digest('hex'),
    results, captures, ownedPort: runtime?.port,
    management: 'Labeled fixture provider only; actual service framing/authorization and stage are not proved',
  }, null, 2) + '\n');
});
async function login(page) {
  await runtime.login(page);
}
async function published(page, route) {
  await page.getByRole('heading', { name: route.after, exact: true }).waitFor({ timeout: 7000 });
  assert.equal(await page.getByRole('heading', { name: route.before, exact: true }).count(), 0);
}
for (const route of compiledCases) {
  test(`native compiled edit survives client navigation to ${route.path}`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      if (route.path === '/app') await login(page);
      const start = route.path === '/reference' ? '/records' : '/reference';
      await page.goto(runtime.origin + start);
      await published(page, compiledCases.find(item => item.path === start));
      const documentTime = await page.evaluate(() => performance.timeOrigin);
      const name = route.path === '/records' ? 'Public record' : route.path === '/reference' ? 'Prerendered reference' : 'Operator app';
      await page.getByRole('link', { name, exact: true }).click();
      await page.waitForURL(url => url.pathname === route.path);
      await published(page, route);
      assert.equal(await page.evaluate(() => performance.timeOrigin), documentTime, 'native navigation must preserve the document');
      if (route.path !== '/app') assert.equal(await page.locator('[data-rer-editor]').count(), 0);
      assert.deepEqual(errors, []);
      results.push({ path: route.path, operation: 'native navigation', status: 'passed' });
    } finally { await page.close(); }
  });
  test(`native compiled edit survives direct hydration and reload at ${route.path}`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      if (route.path === '/app') await login(page);
      await page.goto(runtime.origin + route.path);
      await published(page, route);
      await page.reload();
      await published(page, route);
      assert.deepEqual(errors, []);
      results.push({ path: route.path, operation: 'direct hydration and reload', status: 'passed' });
    } finally { await page.close(); }
  });
}
test('native authorization, actual application frame-src, private overlay and published reload agree', async () => {
  const page = await browser.newPage();
  const errors = [], fetches = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'fetch') fetches.add(request); });
  try {
    const denied = await page.request.get(runtime.origin + '/api/editor/config');
    assert.equal(denied.status(), 403);
    assert.match(denied.headers()['cache-control'], /no-store/);
    assert.equal(denied.headers()['x-reference-dispatch'], 'hono');
    const csrf = await page.request.post(runtime.origin + '/auth/bootstrap', {
      headers: { origin: 'https://attacker.example' }, data: { email: 'operator@example.test', password: 'test-compiled-password' },
    });
    assert.equal(csrf.status(), 403);
    await login(page);
    const response = await page.goto(runtime.origin + '/app');
    const policy = response.headers()['content-security-policy'];
    assert.equal(policy, `base-uri 'self'; object-src 'none'; frame-src 'self' ${runtime.provider.origin}`);
    await published(page, compiledCases.find(item => item.path === '/app'));
    await page.getByRole('button', { name: 'Open Run Edit Run', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-rer-editor]')?.dataset.connection === 'connected');
    const frame = page.frames().find(item => item.url().startsWith(runtime.provider.origin));
    assert.ok(frame);
    const compiled = compiledSnapshot.edits.find(item => item.path === '/app');
    await frame.evaluate(snapshot => send('live-edits', { snapshot }), {
      revision: 6, edits: [{ ...compiled, revision: 6, parentOrigin: runtime.origin, change: { text: 'Private native overlay' } }],
    });
    await page.getByRole('heading', { name: 'Private native overlay', exact: true }).waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.frameLocator('iframe').getByText('Labeled local management fixture').waitFor();
      const path = join(evidence, `compiled-native-${width}.jpg`);
      await page.screenshot({ path, type: 'jpeg', quality: 88 });
      captures.push({ width, path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    await page.getByRole('button', { name: 'Close Run Edit Run', exact: true }).click();
    await page.getByRole('link', { name: 'Public record', exact: true }).click();
    await published(page, compiledCases.find(item => item.path === '/records'));
    assert.equal(await page.locator('[data-rer-editor]').count(), 0);
    await page.getByRole('link', { name: 'Operator app', exact: true }).click();
    await published(page, compiledCases.find(item => item.path === '/app'));
    assert.equal(await page.getByRole('heading', { name: 'Private native overlay', exact: true }).count(), 0);
    // Returning to /app renders the cached match and revalidates its loader in the
    // background. Signing out before that loader answers makes the app navigate to
    // /signin itself, which aborts the reload below; let the page settle first.
    await page.getByRole('button', { name: 'Revoke', exact: true }).waitFor();
    await Promise.all([...fetches].map(async request => (await request.response())?.finished()));
    assert.equal((await page.request.post(runtime.origin + '/auth/signout', { headers: { origin: runtime.origin }, data: {} })).status(), 204);
    assert.equal((await page.request.get(runtime.origin + '/api/editor/config')).status(), 403);
    await page.reload();
    await page.waitForURL(url => url.pathname === '/signin');
    // The shared sign-in page is server-rendered auth chrome: no editor and no published edits.
    await page.getByRole('heading', { name: /^Sign in to / }).waitFor();
    assert.equal(await page.locator('[data-rer-editor]').count(), 0);
    assert.deepEqual(errors, []);
    results.push({ operation: 'native session, CSRF, application CSP, private overlay cleanup and logout', status: 'passed' });
  } finally { await page.close(); }
});
