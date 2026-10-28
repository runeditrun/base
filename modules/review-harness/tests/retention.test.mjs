import { namedSteps } from './fold-steps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, readdir, stat, mkdir, writeFile, symlink, cp } from 'node:fs/promises';
import { journey, ReviewError } from '../index.mjs';
import { consumer, fixture, temporary } from './helpers.mjs';

async function review(runtime, options) {
  try { return (await journey({ cwd: consumer, origin: runtime.origin, ...options })).report; }
  catch (error) { if (error instanceof ReviewError) return error.report; throw error; }
}
async function manifest(evidence, report) {
  assert.deepEqual(JSON.parse(await readFile(join(evidence, 'review.json'), 'utf8')), report);
  const pngs = (await readdir(evidence)).filter(name => name.endsWith('.png'));
  assert.equal(pngs.length, report.captures.reduce((sum, entry) => sum + entry.images.length, 0));
  for (const entry of report.captures) {
    assert.equal(entry.imageRetention.kept, entry.images.length > 0);
    for (const image of entry.images) {
      const bytes = await readFile(join(evidence, image.file));
      assert.ok(bytes.length > 0);
      assert.equal(bytes.length, image.bytes);
    }
  }
}

test("review evidence retains audited failures, selects passing images and prunes only bounded owned history", async t => {
  const step = namedSteps(t);
  await step('accessibility still fails a failures-only run after passing states were audited without images', async t => {
    const runtime = await fixture(t);
    const report = await review(runtime, { evidence: runtime.evidence, capturePolicy: 'failures', widths: [390], async run({ page, capture }) {
      await page.goto('/clean');
      const clean = await capture('clean');
      assert.equal(clean.gate.passed, true);
      assert.deepEqual(clean.images, []);
      assert.equal(clean.keyboard.passed, true);
      await page.goto('/defects/axe');
      await capture('inaccessible');
      assert.fail('a failing audit must reject the capture');
    } });
    assert.equal(report.passed, false);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.captures[1].gate.failures, ['axe']);
    assert.ok(report.captures[1].axe.violations.length > 0);
    await manifest(runtime.evidence, report);
  });

  await step('every policy keeps failures, selects passing images explicitly and records every audited state', async t => {
    const runtime = await fixture(t);
    for (const capturePolicy of [undefined, 'canonical', 'failures', 'exhaustive']) {
      const evidence = join(runtime.directory, capturePolicy ?? 'default');
      const report = await review(runtime, { evidence, capturePolicy, widths: [390], async run({ page, capture }) {
        await page.goto('/clean');
        await page.evaluate(() => { document.body.style.minHeight = '1600px'; });
        await capture('ordinary');
        await page.evaluate(() => document.activeElement.blur());
        // Observe the real screenshot rather than replacing its bytes. Selected
        // views must be recorded before the keyboard audit changes focus.
        const screenshot = page.screenshot.bind(page);
        let canonicalImage = true;
        page.screenshot = async options => {
          if (canonicalImage) assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
          return screenshot(options);
        };
        await capture('canonical', { canonical: true, imageViews: ['viewport', 'full-page'] });
        canonicalImage = false;
        await page.goto('/defects/page-error');
        await capture('broken', { continueOnFailure: true });
      } });
      const policy = capturePolicy ?? 'canonical';
      assert.equal(report.capturePolicy, policy);
      assert.equal(report.passed, false);
      assert.deepEqual(report.errors, []);
      assert.equal(report.captures.length, 3);
      const [ordinary, canonical, failure] = report.captures;
      assert.equal(ordinary.imageRetention.kept, policy === 'exhaustive');
      assert.equal(canonical.imageRetention.kept, policy !== 'failures');
      if (!ordinary.images.length) assert.equal(ordinary.imageRetention.reason, policy === 'failures' ? 'passing-state' : 'noncanonical-state');
      if (!canonical.images.length) assert.equal(canonical.imageRetention.reason, 'passing-state');
      assert.equal(ordinary.images.length, policy === 'exhaustive' ? 1 : 0);
      if (policy !== 'failures') {
        assert.equal(canonical.images.length, 2);
        const sizes = {};
        for (const image of canonical.images) sizes[image.view] = (await readFile(join(evidence, image.file))).readUInt32BE(20);
        assert.equal(sizes.viewport, 844);
        assert.equal(sizes['full-page'], 1600);
      }
      assert.deepEqual(failure.gate.failures, ['pageErrors']);
      assert.equal(failure.imageRetention.reason, 'failure');
      assert.equal(failure.images.length, 1);
      await manifest(evidence, report);
    }
  });

  await step('repeated public journeys bound owned history and preserve foreign folders, copied markers and symlinks', async t => {
    const runtime = await fixture(t);
    const directory = await temporary(t);
    const evidence = join(directory, 'proof');
    const foreign = join(directory, 'proof.previous-foreign');
    await mkdir(foreign);
    await writeFile(join(foreign, 'owner-document'), 'Keep this foreign proof');
    const foreignLink = join(directory, 'proof.previous-symlink');
    await symlink(foreign, foreignLink);
    const run = async ({ page, capture }) => { await page.goto('/clean'); await capture('clean'); };
    const perform = historyLimit => review(runtime, { evidence, capturePolicy: 'failures', historyLimit, widths: [390], run });
    await perform();
    const copied = join(directory, 'proof.previous-copied');
    await cp(evidence, copied, { recursive: true });
    const foreignProof = join(directory, 'foreign-proof');
    await mkdir(foreignProof);
    await writeFile(join(foreignProof, 'owner-document'), 'Keep this too');
    await assert.rejects(journey({ cwd: consumer, origin: runtime.origin, evidence: foreignProof, widths: [390], run }), /not owned/);
    let runs = 1;
    for (const historyLimit of [undefined, undefined, 1, 0]) {
      const report = await perform(historyLimit);
      assert.equal(report.passed, true);
      const folders = (await readdir(directory)).filter(name => name.startsWith('proof.previous-'));
      const owned = folders.filter(name => !['proof.previous-foreign', 'proof.previous-symlink', 'proof.previous-copied'].includes(name));
      assert.equal(owned.length, Math.min(++runs - 1, historyLimit ?? report.historyLimit));
      for (const name of owned) assert.equal(JSON.parse(await readFile(join(directory, name, 'review.json'), 'utf8')).passed, true);
      assert.equal(await readFile(join(foreign, 'owner-document'), 'utf8'), 'Keep this foreign proof');
      assert.equal(await readFile(join(foreignProof, 'owner-document'), 'utf8'), 'Keep this too');
      assert.ok((await stat(join(copied, 'review.json'))).isFile());
      assert.ok((await stat(foreignLink)).isDirectory());
      await manifest(evidence, report);
    }
  });
})
