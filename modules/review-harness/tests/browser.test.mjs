import { namedSteps, caseRows } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { journey, signIn, ReviewError, VIEWPORTS, settle } from '../index.mjs';
import { consumer, fixture, openSignIn, syntheticSecret } from './helpers.mjs';

async function reviewed(runtime, run, extra = {}) {
  try { return await journey({ cwd: consumer, origin: runtime.origin, evidence: runtime.evidence, secrets: [syntheticSecret], run, ...extra }); }
  catch (error) { if (error instanceof ReviewError) return { report: error.report, reportPath: error.reportPath }; throw error; }
}
async function verifyFiles(result) {
  const disk = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.deepEqual(disk, result.report);
  assert.equal((await stat(result.reportPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(result.reportPath, '..'))).mode & 0o777, 0o700);
  assert.ok(Date.parse(disk.finishedAt) >= Date.parse(disk.startedAt));
  assert.ok(disk.versions.chromium);
  assert.deepEqual(disk.versions.pinned, disk.versions.actual);
  assert.match(disk.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const entry of disk.captures) {
    assert.equal(entry.imageRetention.kept, entry.images.length > 0);
    if (!entry.images.length) assert.ok(entry.imageRetention.reason);
    for (const image of entry.images) {
      const path = join(result.reportPath, '..', image.file);
      assert.equal((await readFile(path)).length, image.bytes);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.equal(Object.values(entry.axe.counts).reduce((a, b) => a + b, 0), entry.axe.violations.length);
  }
}
test('oneclick sign-in and app pass in fresh contexts at both default viewports', async t => {
  const runtime = await fixture(t);
  let firstContext;
  const result = await reviewed(runtime, async ({ page, context, viewport, capture }) => {
    assert.deepEqual(viewport, VIEWPORTS.find(value => value.width === viewport.width));
    assert.notEqual(context, firstContext); firstContext = context;
    await page.goto('/app');
    assert.equal(new URL(page.url()).pathname, '/signin', 'a new width has no prior session');
    await capture('sign in');
    await signIn(page, { origin: runtime.origin, open: viewport.width === 390 ? openSignIn : async page => { await page.goto('/auth/oneclick'); } });
    assert.equal(new URL(page.url()).pathname, '/app');
    assert.equal(new URL(page.url()).search, '');
    await page.getByText('You are signed in.', { exact: true }).waitFor();
    await capture('app');
  });
  assert.equal(result.report.passed, true);
  assert.deepEqual(result.report.totals, { captures: 4, passed: 4, failed: 0 });
  await verifyFiles(result);
  assert.equal((await readFile(result.reportPath, 'utf8')).includes('token='), false);
});
test("browser captures record exact gate failures, preserve evidence and honour per-capture policy", async t => {
  await caseRows(t, [["browser captures record exact gate failures, preserve evidence and honour per-capture policy", async t => {
  const step = namedSteps(t);
  await step('each defect page fails exactly its gate and writes a complete report', async t => {
    const runtime = await fixture(t);
    const cases = { axe: 'axe', overflow: 'overflow', 'page-error': 'pageErrors', 'console-error': 'consoleErrors', hydration: 'consoleErrors', subresource: 'failedResponses', secret: 'secrets', keyboard: 'keyboard' };
    const result = await reviewed(runtime, async ({ page, width, capture }) => {
      for (const [path, gate] of Object.entries(cases)) {
        await page.goto(`/defects/${path}?token=synthetic-url-token&view=review`);
        const entry = await capture(path, { continueOnFailure: true });
        assert.deepEqual(entry.gate.failures, path === 'overflow' && width === 1440 ? [] : [gate], path);
        assert.equal(entry.path, `/defects/${path}?view=review`);
        if (path === 'axe') {
          assert.ok(entry.axe.violations.every(value => value.id && value.help && value.targets.length));
          assert.ok(entry.axe.counts.serious > 0, 'the fixture exercises a serious violation');
        }
      }
    });
    assert.equal(result.report.passed, false);
    assert.deepEqual(result.report.errors, []);
    assert.deepEqual(result.report.totals, { captures: 16, passed: 1, failed: 15 });
    await verifyFiles(result);
    const json = await readFile(result.reportPath, 'utf8');
    assert.equal(json.includes('synthetic-url-token'), false);
    assert.equal(json.includes(syntheticSecret), false);
  });

  await step('capture throws on a gate failure after recording evidence; expected document status is configurable', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page, capture }) => {
      await page.goto('/not-found');
      assert.equal((await capture('expected missing', { expectStatus: 404 })).gate.passed, true);
      await page.goto('/defects/page-error');
      await capture('broken');
      assert.fail('a failing capture must throw');
    });
    assert.equal(result.report.passed, false);
    assert.equal(result.report.captures.length, 4);
    assert.deepEqual(result.report.errors, []);
    await verifyFiles(result);
  });

  await step('keyboard is on by default; disabling it needs a recorded reason', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page, capture }) => {
      await page.goto('/defects/keyboard');
      await assert.rejects(capture('no reason', { keyboard: false }), /requires keyboardReason/);
      const entry = await capture('document only', { keyboard: false, keyboardReason: 'This static document has no actions.' });
      assert.deepEqual(entry.keyboard, { enabled: false, passed: true, reason: 'This static document has no actions.' });
    });
    assert.equal(result.report.passed, true);
  });

  await step('per-capture secrets are checked alongside journey secrets', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page, capture }) => {
      await page.goto('/defects/secret');
      const entry = await capture('private document', { secrets: [syntheticSecret], continueOnFailure: true });
      assert.deepEqual(entry.gate.failures, ['secrets']);
    }, { widths: [390], secrets: [] });
    assert.equal(result.report.passed, false);
    assert.deepEqual(result.report.errors, []);
    assert.deepEqual(result.report.captures[0].gate.failures, ['secrets']);
  });

  }]]);
})

test('external routing aborts a second local origin before it receives any request; data and blob are allowed', async t => {
  let requests = 0;
  const external = createServer((_req, res) => { requests++; res.end('foreign'); });
  external.listen(0, '127.0.0.1'); await once(external, 'listening');
  t.after(() => new Promise(resolve => external.close(resolve)));
  const runtime = await fixture(t, { args: ['--external', `http://127.0.0.1:${external.address().port}`] });
  const result = await reviewed(runtime, async ({ page, capture }) => {
    await page.goto('/defects/external');
    assert.deepEqual((await capture('external', { continueOnFailure: true })).gate.failures, ['externalRequests']);
    await page.goto('/data-blob');
    assert.equal((await capture('data blob', { continueOnFailure: true })).gate.passed, true);
  });
  assert.equal(requests, 0);
  assert.deepEqual(result.report.errors, []);
  assert.equal(result.report.captures.length, 4);
});


test("browser settling awaits fonts, frames, animations, network and bounded busy state", async t => {
  await caseRows(t, [["browser settling awaits fonts, frames, animations, network and bounded busy state", async t => {
  const step = namedSteps(t);
  await step('settle awaits busy state, finite animations, fonts and two frames, then scrolls to the top', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page, capture }) => {
      await page.goto('/settle');
      await page.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollTo(0, 1000); });
      const entry = await capture('settled', { canonical: true });
      assert.equal(entry.gate.passed, true);
      assert.equal(await page.locator('#busy').textContent(), 'Ready');
      assert.equal(await page.locator('#animated').getAttribute('data-finished'), 'yes');
      assert.equal(await page.evaluate(() => scrollY), 0);
      const png = await readFile(join(runtime.evidence, entry.images[0].file));
      assert.equal(png.readUInt32BE(20), 3000, 'full-page PNG height includes the entire document');
    }, { widths: [{ width: 390, height: 700 }] });
    assert.equal(result.report.passed, true);
  });

  await step('a page that stays busy fails within the settle bound', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page, capture }) => {
      await page.goto('/busy');
      const entry = await capture('busy', { timeoutMs: 2000, continueOnFailure: true });
      assert.deepEqual(entry.gate.failures, ['settle']);
    }, { widths: [390] });
    assert.equal(result.report.passed, false);
    assert.deepEqual(result.report.errors, []);
    assert.deepEqual(result.report.captures[0].gate.failures, ['settle']);
  });

  await step('settle primitive waits for fonts and two real frames before returning', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page }) => {
      await page.goto('/clean');
      await page.evaluate(() => {
        window.reviewFrames = 0; window.reviewFontReady = false;
        const original = window.requestAnimationFrame;
        window.requestAnimationFrame = callback => original.call(window, time => { window.reviewFrames++; callback(time); });
        Object.defineProperty(document.fonts, 'ready', { value: new Promise(resolve => setTimeout(() => { window.reviewFontReady = true; resolve(); }, 900)) });
      });
      await settle(page);
      assert.equal(await page.evaluate(() => window.reviewFontReady), true);
      assert.ok(await page.evaluate(() => window.reviewFrames) >= 2);
    }, { widths: [390] });
    assert.equal(result.report.passed, true);
  });

  await step('settle primitive awaits finite animations and busy state before returning', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page }) => {
      await page.goto('/settle');
      await page.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollTo(0, 1000); });
      await settle(page);
      assert.equal(await page.locator('#busy').textContent(), 'Ready');
      assert.equal(await page.locator('#animated').getAttribute('data-finished'), 'yes');
      assert.equal(await page.evaluate(() => scrollY), 0);
    }, { widths: [390] });
    assert.equal(result.report.passed, true);
  });

  await step('settle primitive waits for network idle before returning', async t => {
    const runtime = await fixture(t);
    const result = await reviewed(runtime, async ({ page }) => {
      await page.goto('/network', { waitUntil: 'domcontentloaded' });
      await settle(page);
      assert.equal(await page.locator('img').evaluate(image => image.complete), true);
    }, { widths: [390] });
    assert.equal(result.report.passed, true);
  });

  }]]);
})
