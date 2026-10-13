import { queuedEntrypoint } from '../queued-entry.mjs';
const queuedExit=await queuedEntrypoint(import.meta.url,'verify:browser');
if(queuedExit!==null)process.exit(queuedExit);
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startInstaller } from '../server.mjs';
import { createOutputRoot, finishOutputRoot } from './browser-output.mjs';

const requireFromDefaultSeed = createRequire(new URL('../../default-seed/package.json', import.meta.url));
const { chromium } = requireFromDefaultSeed('@playwright/test');
const requireFromAxePlaywright = createRequire(requireFromDefaultSeed.resolve('@axe-core/playwright'));
const axePath = process.env.AXE_CORE_PATH ? resolve(process.env.AXE_CORE_PATH) : requireFromAxePlaywright.resolve('axe-core');
const axeSource = await readFile(axePath, 'utf8');
const taskTemp = resolve(process.env.TMPDIR || tmpdir());

const editionSource = `
export const product = { name: 'Installer layout fixture', slugPrefix: 'layout' };
export const branding = { name: 'Installer layout fixture', accent: '#7542d3' };
export const features = { hosting: true, github: true, localTrialWithoutEmail: true };
export function readySummary(draft) { return draft.TEAM_NAME + ' is ready to install.'; }
`;
const fixtureManifest = {schema:1,title:'Layout fixture',groups:[{id:'owner',label:'Your workspace'},{id:'workspace',label:'What it is for'},{id:'email',label:'Email setup'}],fields:[
 {name:'TEAM_NAME',label:'Workspace name',kind:'text',required:true,group:'owner'},
 {name:'PURPOSE',label:'What will this workspace help you do?',kind:'text',required:true,group:'workspace'},
 {name:'EMAIL_PROVIDER',label:'Email setup',kind:'select',required:true,default:'later',group:'email',options:[{value:'later',label:'Set up later'},{value:'resend',label:'Resend'}]},
 {name:'EMAIL_FROM',label:'From address',kind:'email',required:true,group:'email',when:{field:'EMAIL_PROVIDER',equals:'resend'}},
 {name:'EMAIL_API_KEY',label:'Email API key',kind:'secret',input:'entered',ownerVisible:true,required:true,group:'email',when:{field:'EMAIL_PROVIDER',equals:'resend'}},
],steps:[{type:'extension',id:'fixture'}]};
const backgroundSource = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#174e67"/><stop offset="1" stop-color="#6e8094"/></linearGradient><radialGradient id="light"><stop stop-color="#e7c8b5" stop-opacity=".85"/><stop offset="1" stop-color="#e7c8b5" stop-opacity="0"/></radialGradient></defs><rect width="1440" height="900" fill="url(#sky)"/><ellipse cx="1160" cy="180" rx="340" ry="260" fill="url(#light)"/><path d="M0 680 220 530l190 110 230-210 240 170 230-230 330 250v280H0Z" fill="#123f55" fill-opacity=".42"/><path d="M0 760 230 670l260 80 240-130 270 150 210-110 230 70v170H0Z" fill="#0d344a" fill-opacity=".58"/></svg>`;
const outputRoot = await createOutputRoot(taskTemp);
const editionPath = join(outputRoot, 'browser-edition.mjs');
await writeFile(editionPath, editionSource);
await writeFile(join(outputRoot, 'background.svg'), backgroundSource);
const edition = await import(pathToFileURL(editionPath).href);
const seed = {
  product: edition.product.name,
  branding: edition.branding,
  features: edition.features,
  browserModule: 'seed.mjs',
  background: 'background.svg',
  setup: {manifestFile:'rer-setup.json'},
  async install(_root, _input, store) {
    await store.step('Starting the fixture workspace');
    await store.phase('complete');
  },
};
const browser = await chromium.launch({ headless: true });
const results = [];

async function checkViewport(width, height) {
  const root = await mkdtemp(join(taskTemp, `onboarding-ui-root-${width}x${height}-`));
  let installer;
  let context;
  try {
    await writeFile(join(root, 'seed.mjs'), editionSource);
    await writeFile(join(root, 'rer-setup.json'), JSON.stringify(fixtureManifest,null,2)+'\n');
    await writeFile(join(root, 'background.svg'), backgroundSource);
    installer = await startInstaller(root, { seed, port: 0, noPrefill: true });
    context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript({ content: axeSource });
    const page = await context.newPage();
    await page.goto(installer.origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#form')?.hidden && document.querySelector('#heading')?.textContent);

    async function capture(step) {
      const actionSelector = step === 'review' ? '#approve' : '#continue';
      const viewportState = await page.evaluate(action => {
        const heading = document.querySelector('#heading').getBoundingClientRect();
        const actionButton = document.querySelector(action), button = actionButton.getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          headingText: document.querySelector('#heading').textContent.trim(),
          headingVisible: heading.top >= 0 && heading.bottom <= innerHeight,
          actionLabel: actionButton.textContent.trim(),
          actionVisible: !actionButton.hidden && button.top >= 0 && button.bottom <= innerHeight,
        };
      }, actionSelector);
      assert.equal(viewportState.documentWidth, width, `${width}px ${step}: horizontal overflow`);
      assert.ok(viewportState.headingVisible, `${width}px ${step}: heading is outside the first viewport`);
      assert.ok(viewportState.actionVisible, `${width}px ${step}: the setup action is outside the first viewport`);
      const screenshotPath = join(outputRoot, 'screenshots', `${width}x${height}-${step}.png`);
      await page.screenshot({ path: screenshotPath });

      const axe = await page.evaluate(async () => {
        if (!window.axe) throw new Error('axe-core did not load into the page.');
        return window.axe.run(document);
      });
      const serious = axe.violations.filter(item => ['serious', 'critical'].includes(item.impact));
      const report = {
        viewport: { width, height },
        step,
        violations: axe.violations,
        seriousOrCritical: serious.length,
      };
      await writeFile(join(outputRoot, 'axe', `${width}x${height}-${step}.json`), JSON.stringify(report, null, 2) + '\n');
      assert.equal(serious.length, 0, `${width}px ${step}: axe serious/critical violations were found`);
      results.push({ ...viewportState, screenshot: basename(screenshotPath), seriousOrCritical: serious.length });
    }

    await capture('workspace');
    assert.equal(await page.locator('#known-summary').evaluate(element => element.hidden), true, 'answer summary should stay hidden before answers');
    assert.equal(await page.locator('#activity').evaluate(element => element.hidden), true, 'manual setup and agent connection should stay hidden before answers');
    await page.locator('#TEAM_NAME').fill('Local team');
    await page.locator('#continue').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'What it is for');
    await capture('purpose');
    await page.locator('#PURPOSE').fill('A private test workspace');
    await page.locator('#continue').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Hosting & connections');
    await capture('hosting');
    assert.equal(await page.locator('#target-local').isChecked(), true, 'declared local trial should be preselected');
    const emailResponse=await page.request.get(installer.origin+'/rer-setup.json');
    assert.deepEqual(await emailResponse.json(),fixtureManifest,'browser reads committed manifest bytes');
    assert.match(await page.locator('[data-provider="github"] .help').textContent(), /You can connect GitHub later/);
    assert.match(await page.locator('[data-provider="github"] .help').textContent(), /cli\.github\.com/);
    assert.equal(await page.locator('#error').evaluate(element => element.hidden), true, 'optional GitHub instructions must not use error styling');
    await page.locator('#continue').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Ready to install');
    await capture('review');
    const summaryPosition = await page.evaluate(() => ({
      formBottom: document.querySelector('#form').getBoundingClientRect().bottom,
      summaryTop: document.querySelector('#known-summary').getBoundingClientRect().top,
      summaryHidden: document.querySelector('#known-summary').hidden,
      summaryOpen: document.querySelector('#known-summary').open,
    }));
    assert.equal(summaryPosition.summaryHidden, false, 'answered values should appear in the summary');
    assert.equal(summaryPosition.summaryOpen, false, 'answer summary should start collapsed');
    assert.ok(summaryPosition.summaryTop >= summaryPosition.formBottom, 'answer summary should be below the setup form');
    await auditExpandedSummary(page, width, height);
  } finally {
    await context?.close();
    await installer?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function auditExpandedSummary(page, width, height) {
  await page.locator('#known-summary > summary').click();
  const measurements = await page.evaluate(() => {
    const channels = value => (value.match(/[\d.]+/g) || []).map(Number);
    const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const luminance = value => {
      const [red, green, blue] = channels(value).slice(0, 3).map(channel => linear(channel / 255));
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const contrast = (foreground, background) => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const selectors = ['.known-group-title', '.known-label', '.known-value-text', '.edit', '.known-source'];
    const items = selectors.flatMap(selector => [...document.querySelectorAll(`#known-summary ${selector}`)].map(element => {
      const group = element.closest('.known-group');
      const style = getComputedStyle(element), background = getComputedStyle(group);
      return {
        selector,
        text: element.textContent.trim(),
        color: style.color,
        background: background.backgroundColor,
        backgroundImage: background.backgroundImage,
        alpha: channels(background.backgroundColor)[3] ?? 1,
        ratio: contrast(style.color, background.backgroundColor),
      };
    }));
    const summary = document.querySelector('#known-summary > summary');
    const summaryStyle = getComputedStyle(summary), summaryBackground = getComputedStyle(summary);
    items.push({
      selector: 'summary',
      text: summary.textContent.trim(),
      color: summaryStyle.color,
      background: summaryBackground.backgroundColor,
      backgroundImage: summaryBackground.backgroundImage,
      alpha: channels(summaryBackground.backgroundColor)[3] ?? 1,
      ratio: contrast(summaryStyle.color, summaryBackground.backgroundColor),
    });
    return items;
  });
  assert.ok(measurements.some(item => item.selector === '.known-label'), `${width}px summary: no labels were measured`);
  for (const item of measurements) {
    assert.equal(item.alpha, 1, `${width}px summary ${item.selector}: background is not opaque`);
    assert.equal(item.backgroundImage, 'none', `${width}px summary ${item.selector}: background uses an image or gradient`);
    assert.ok(item.ratio >= 4.5, `${width}px summary ${item.selector} ${JSON.stringify(item.text)}: contrast ${item.ratio.toFixed(2)}:1 is below 4.5:1`);
  }
  const axe = await page.evaluate(async () => window.axe.run(document));
  const serious = axe.violations.filter(item => ['serious', 'critical'].includes(item.impact));
  // Scope the incomplete-result check to the summary itself: axe must be able to
  // compute every contrast ratio there, not merely report no violation.
  const summaryAxe = await page.evaluate(async () => window.axe.run(document.querySelector('#known-summary'), { runOnly: ['color-contrast'] }));
  const incompleteSummaryContrast = summaryAxe.incomplete.filter(item => item.id === 'color-contrast').flatMap(item => item.nodes);
  const report = { viewport: { width, height }, step: 'summary-open', measurements, violations: axe.violations, incompleteSummaryContrast, seriousOrCritical: serious.length };
  await writeFile(join(outputRoot, 'axe', `${width}x${height}-summary-open.json`), JSON.stringify(report, null, 2) + '\n');
  assert.equal(serious.length, 0, `${width}px summary: axe serious/critical violations were found`);
  assert.equal(incompleteSummaryContrast.length, 0, `${width}px summary: axe could not calculate text contrast`);
  const summaryText = await page.locator('#known').innerText();
  assert.match(summaryText, /On this computer/, `${width}px summary: reviewed local default is missing`);
  assert.match(summaryText, /Set up later/, `${width}px summary: reviewed no-email default is missing`);
}

function makeLifecycleSeed() {
  let attempt = 0;
  return {
    ...seed,
    async install(root, _input, store, onApp, signal) {
      attempt += 1;
      if (attempt === 1) {
        const child = store.spawn('Starting the fixture workspace', process.execPath, ['-e', 'for(let i=1;i<=45;i++)console.log(`slow-fixture-line-${String(i).padStart(2,"0")}`);setInterval(()=>{},1000)'], { cwd: root, signal });
        onApp(child);
        await store.waitForReady('Starting the fixture workspace', child, async () => false, { signal, intervalMs: 1000, softAfterMs: 1, timeoutMs: 30000 });
        return;
      }
      if (attempt === 2) {
        await store.run('Building fixture', process.execPath, ['-e', 'for(let i=1;i<=45;i++)console.log(`failure-fixture-line-${String(i).padStart(2,"0")}`);process.exitCode=23'], { cwd: root, signal });
        return;
      }
      await store.step('Restart completed with saved answers');
      await store.phase('complete');
    },
  };
}

async function checkLifecycleViewport(width, height) {
  const root = await mkdtemp(join(taskTemp, `onboarding-ui-lifecycle-root-${width}x${height}-`));
  let installer;
  let context;
  try {
    await writeFile(join(root, 'seed.mjs'), editionSource);
    await writeFile(join(root, 'rer-setup.json'), JSON.stringify(fixtureManifest,null,2)+'\n');
    await writeFile(join(root, 'background.svg'), backgroundSource);
    installer = await startInstaller(root, { seed: makeLifecycleSeed(), port: 0, noPrefill: true });
    installer.state.known.providers.github = { installed: false };
    installer.state.known.providers.cloudflare = { installed: false };
    context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(installer.origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#form')?.hidden && document.querySelector('#heading')?.textContent);
    await page.locator('#TEAM_NAME').fill('Retry team');
    await page.locator('#continue').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'What it is for');
    await page.locator('#PURPOSE').fill('A saved setup for retry');
    await page.locator('#continue').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Hosting & connections');
    assert.equal(await page.locator('[data-provider="github"] .help a').getAttribute('href'), 'https://cli.github.com', `${width}px GitHub CLI instructions should link to the real download page`);
    await page.locator('label.target-choice').filter({ hasText: 'Online for your team' }).click();
    const wranglerHelp = await page.locator('[data-provider="cloudflare"] .help').textContent();
    assert.match(wranglerHelp, /npm install --global wrangler/, `${width}px missing Wrangler instructions should include the install command`);
    assert.match(wranglerHelp, /API token/, `${width}px missing Wrangler instructions should mention the token alternative`);
    assert.equal(await page.locator('[data-provider="cloudflare"] #connect-cloudflare').count(), 0, `${width}px missing Wrangler should not offer an unavailable sign-in action`);
    await page.locator('[data-provider="cloudflare"] button').filter({ hasText: 'Use an API token' }).click();
    assert.equal(await page.locator('#apiToken').isVisible(), true, `${width}px API-token alternative should reveal the token field`);
    await page.locator('label.target-choice').filter({ hasText: 'On this computer' }).click();
    await page.locator('#continue').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Ready to install');
    await page.locator('#approve').click();
    await page.waitForFunction(() => document.querySelector('#current-step')?.textContent.includes('Still starting'), null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#logs')?.textContent.includes('slow-fixture-line-45'), null, { timeout: 10000 });

    const initialStatus = await page.evaluate(() => {
      const lines = document.querySelector('#logs').textContent.split('\n');
      return { status: document.querySelector('#current-step').textContent, latest: lines.filter(line => /\bStill starting \(\d+ s\)$/.test(line)).at(-1) };
    });
    assert.equal(initialStatus.status, initialStatus.latest, `${width}px slow-start status should show the latest progress line`);
    const atBottom = await page.locator('#logs').evaluate(element => ({
      atBottom: element.scrollHeight - element.clientHeight - element.scrollTop <= 2,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      lineCount: element.textContent.split('\n').filter(line => /^slow-fixture-line-\d+$/.test(line)).length,
    }));
    assert.equal(atBottom.lineCount, 45, `${width}px running log: expected all fixture lines`);
    assert.ok(atBottom.scrollHeight > atBottom.clientHeight, `${width}px running log: fixture did not create a scrollable log`);
    assert.ok(atBottom.atBottom, `${width}px running log: new output did not follow the tail`);

    await page.locator('#logs').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(previous => {
      const current = document.querySelector('#current-step')?.textContent || '';
      return current.includes('Still starting') && current !== previous;
    }, initialStatus.status, { timeout: 10000 });
    const preserved = await page.evaluate(() => {
      const element = document.querySelector('#logs'), lines = element.textContent.split('\n');
      return { scrollTop: element.scrollTop, status: document.querySelector('#current-step').textContent, latest: lines.filter(line => /\bStill starting \(\d+ s\)$/.test(line)).at(-1) };
    });
    assert.equal(preserved.scrollTop, 0, `${width}px running log: polling moved a reader who scrolled up`);
    assert.equal(preserved.status, preserved.latest, `${width}px slow-start status should keep showing its latest update`);

    await page.locator('#logs').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    const beforeResume = await page.locator('#current-step').textContent();
    await page.waitForFunction(previous => {
      const current = document.querySelector('#current-step')?.textContent || '';
      return current.includes('Still starting') && current !== previous;
    }, beforeResume, { timeout: 10000 });
    const resumedScroll = await page.locator('#logs').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    assert.ok(resumedScroll <= 2, `${width}px running log: following did not resume after scrolling back to the bottom`);

    await page.locator('#stop-installation').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Stopped', null, { timeout: 10000 });
    assert.equal(await page.locator('#error').evaluate(element => element.hidden), true, `${width}px stopped: cancellation should not use error styling`);
    assert.equal(await page.locator('#progress').evaluate(element => element.hidden), true, `${width}px stopped: stale setup progress should be hidden`);
    assert.equal(await page.locator('#activity').evaluate(element => element.hidden), true, `${width}px stopped: stale agent activity should be hidden`);
    assert.equal(await page.locator('#known-summary').evaluate(element => element.hidden), true, `${width}px stopped: summary edit controls should be hidden`);
    assert.equal((await page.locator('body').innerText()).includes('signal none'), false, `${width}px stopped: raw signal status should not appear in the browser`);

    await page.locator('#retry-installation').click();
    assert.equal(await page.locator('#installation').evaluate(element => element.hidden), true, `${width}px retry: installation view should close for review`);
    assert.equal(await page.locator('#form').evaluate(element => element.hidden), false, `${width}px retry: saved answers should return to the review form`);
    assert.equal(await page.locator('#heading').textContent(), 'Ready to install', `${width}px retry: the review heading should replace Stopped`);
    assert.equal(await page.locator('#progress').evaluate(element => element.hidden), false, `${width}px retry: review progress should be restored`);
    assert.equal(await page.locator('#activity').evaluate(element => element.hidden), false, `${width}px retry: manual setup should return with saved answers`);
    assert.equal(await page.locator('#known-summary').evaluate(element => element.hidden), false, `${width}px retry: saved answers should be visible for review`);
    assert.match(await page.locator('#known').textContent(), /Retry team/, `${width}px retry: saved workspace name was lost`);
    await page.locator('#approve').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Installation needs attention', null, { timeout: 10000 });
    const headline = await page.locator('#error').textContent();
    assert.equal(headline, 'Building fixture: exit 23.', `${width}px failure headline should identify the step and preserve the exit status`);
    assert.equal(headline.includes('\n'), false, `${width}px failure headline should stay on one line`);
    assert.equal(headline.includes('signal none'), false, `${width}px failure headline should omit the empty signal value`);
    assert.equal(headline.includes('failure-fixture-line-'), false, `${width}px failure headline should not duplicate the trace`);
    const logText = await page.locator('#logs').textContent();
    const fixtureLines = logText.split('\n').filter(line => /^failure-fixture-line-\d+$/.test(line));
    assert.deepEqual(fixtureLines, Array.from({ length: 45 }, (_, index) => `failure-fixture-line-${String(index + 1).padStart(2, '0')}`), `${width}px failure log should keep each real child line once`);
    assert.deepEqual(fixtureLines.slice(-40), Array.from({ length: 40 }, (_, index) => `failure-fixture-line-${String(index + 6).padStart(2, '0')}`), `${width}px failure log should expose the actual last 40 lines`);
    assert.equal(await page.locator('#logs').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap', `${width}px failure log should preserve line breaks`);
    assert.equal(await page.locator('#failure-log-path').textContent(), `Installer log: ${join(root, '.seed', 'installer', 'install.log')}`, `${width}px failure log path should remain intact on its own line`);
    const failureLayout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, log: document.querySelector('#logs').getBoundingClientRect().width }));
    assert.equal(failureLayout.document, width, `${width}px failure screen should not overflow horizontally`);
    assert.ok(failureLayout.log <= failureLayout.viewport, `${width}px failure log should fit the viewport`);
    assert.equal(await page.locator('#progress').evaluate(element => element.hidden), true, `${width}px failed: stale setup progress should be hidden`);
    assert.equal(await page.locator('#activity').evaluate(element => element.hidden), true, `${width}px failed: stale agent activity should be hidden`);
    assert.equal(await page.locator('#known-summary').evaluate(element => element.hidden), true, `${width}px failed: summary edit controls should be hidden`);
    assert.equal((await page.locator('body').innerText()).includes('signal none'), false, `${width}px failed: raw signal status should not appear in the browser`);
    await page.locator('#retry-installation').click();
    assert.equal(await page.locator('#error').evaluate(element => element.hidden), true, `${width}px retry after failure: the previous failure headline should clear`);
    assert.equal(await page.locator('#progress').evaluate(element => element.hidden), false, `${width}px retry after failure: review progress should be restored`);
    assert.match(await page.locator('#known').textContent(), /Retry team/, `${width}px retry after failure: saved answers should be reviewable`);
    await page.locator('#approve').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent.trim() === 'Your workspace is ready', null, { timeout: 10000 });
    assert.equal(await page.locator('#progress').evaluate(element => element.hidden), true, `${width}px complete: stale setup progress should be hidden`);
    assert.equal(await page.locator('#activity').evaluate(element => element.hidden), true, `${width}px complete: stale agent activity should be hidden`);
    assert.equal(await page.locator('#known-summary').evaluate(element => element.hidden), true, `${width}px complete: summary edit controls should be hidden`);
  } finally {
    await context?.close();
    await installer?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function checkProgressTransition() {
  const root = await mkdtemp(join(taskTemp, 'onboarding-ui-progress-root-'));
  let installer, context, healthy = false;
  const startupStep = 'Starting the transition workspace', laterStep = 'Preparing the ready workspace';
  try {
    await writeFile(join(root, 'seed.mjs'), editionSource);
    await writeFile(join(root, 'rer-setup.json'), JSON.stringify(fixtureManifest,null,2)+'\n');
    await writeFile(join(root, 'background.svg'), backgroundSource);
    installer = await startInstaller(root, {
      seed: {
        ...seed,
        async install(root, _input, store, onApp, signal) {
          const child = store.spawn(startupStep, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, signal });
          onApp(child);
          await store.waitForReady(startupStep, child, async () => healthy, { signal, intervalMs: 25, softAfterMs: 1, timeoutMs: 30000 });
          await store.run(laterStep, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, signal });
        },
      },
      port: 0,
      noPrefill: true,
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(installer.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#TEAM_NAME').fill('Transition team');
    await page.locator('#continue').click();
    await page.locator('#PURPOSE').fill('Finish startup before the next step');
    await page.locator('#continue').click();
    await page.locator('#continue').click();
    await page.locator('#approve').click();
    await page.waitForFunction(() => document.querySelector('#current-step')?.textContent.includes('Still starting'), null, { timeout: 10000 });
    for (const selector of ['#progress', '#activity', '#known-summary']) {
      assert.equal(await page.locator(selector).evaluate(element => element.hidden), true, `running: ${selector} should hide setup chrome`);
    }
    healthy = true;
    await page.waitForFunction(step => document.querySelector('#current-step')?.textContent === step, laterStep, { timeout: 10000 });
    assert.match(await page.locator('#logs').textContent(), /Starting the transition workspace: Still starting \(\d+ s\)/, 'later running step should retain startup diagnostics');
    assert.equal(await page.locator('#current-step').textContent(), laterStep, 'an old startup progress line should not replace the current running step');
    await page.locator('#stop-installation').click();
    await page.waitForFunction(() => document.querySelector('#heading')?.textContent === 'Stopped', null, { timeout: 10000 });
  } finally {
    await context?.close();
    await installer?.close();
    await rm(root, { recursive: true, force: true });
  }
}

let passed = false;
async function checkManifestInputs() {
 const root=await mkdtemp(join(taskTemp,'onboarding-manifest-browser-'));
 let installer,context;
 const manifest={schema:1,title:'Manifest fields',groups:[],fields:[
  {name:'MODE',label:'Mode',kind:'select',required:true,options:[{value:'local',label:'Local'},{value:'online',label:'Online'}]},
  {name:'PUBLIC_EMAIL',label:'Contact',kind:'email',required:false,when:{field:'MODE',equals:'online'},presentations:[{when:{field:'MODE',equals:'online'},label:'Online contact',required:true}]},
  {name:'ACCESS_KEY',label:'Private key',kind:'secret',input:'entered',ownerVisible:true,required:true,when:{field:'MODE',equals:'online'}},
 ],steps:[{type:'extension',id:'fixture'}]};
 try {
  await writeFile(join(root,'seed.mjs'),"export const product={name:'Manifest browser'}; export const features={};");
  await writeFile(join(root,'background.svg'),backgroundSource);
  await writeFile(join(root,'rer-setup.json'),JSON.stringify(manifest,null,2)+'\n');
  installer=await startInstaller(root,{seed:{product:'Manifest browser',setup:{manifestFile:'rer-setup.json'},browserModule:'seed.mjs',background:'background.svg',install:async()=>{}},noPrefill:true});
  context=await browser.newContext();const page=await context.newPage();await page.goto(installer.origin);
  await page.locator('#MODE').selectOption('online');
  assert.equal(await page.locator('label[for="PUBLIC_EMAIL"]').textContent(),'Online contact');
  assert.equal(await page.locator('#PUBLIC_EMAIL').getAttribute('required'),'');
  assert.equal(await page.locator('#ACCESS_KEY').getAttribute('type'),'password');
  await page.locator('#PUBLIC_EMAIL').fill('invalid');
  await page.locator('#ACCESS_KEY').fill('test-private-browser-value');
  assert.equal(await page.locator('#continue').isDisabled(),true);
  await page.locator('#PUBLIC_EMAIL').fill('owner@example.test');
  assert.equal(await page.locator('#continue').isDisabled(),false);
  await page.locator('#MODE').selectOption('local');
  assert.equal(await page.locator('#PUBLIC_EMAIL').count(),0);
  assert.equal(await page.locator('#ACCESS_KEY').count(),0);
  assert.equal(await page.locator('#continue').isDisabled(),false,'hidden required inputs do not block');
  await page.locator('#MODE').selectOption('online');
  assert.equal(await page.locator('#ACCESS_KEY').inputValue(),'','dependency edits clear entered credentials');
  assert.equal(await page.locator('#continue').isDisabled(),true);
  assert.ok(!JSON.stringify(installer.state).includes('test-private-browser-value'));
  console.log('Manifest browser: conditional labels, requiredness, hidden fields, validation and private-input invalidation passed');
 } finally {await context?.close();await installer?.close();await rm(root,{recursive:true,force:true});}
}
try {
  await checkManifestInputs();
  await checkViewport(1440, 1000);
  await checkViewport(390, 844);
  await checkLifecycleViewport(1440, 1000);
  await checkLifecycleViewport(390, 844);
  await checkProgressTransition();
  console.log(JSON.stringify({ outputRoot, results }, null, 2));
  passed = true;
} finally {
  await browser.close();
  if (await finishOutputRoot(outputRoot, { passed })) console.log(`Removed ${outputRoot}; set KEEP_BROWSER_CHECK=1 to keep screenshots and axe reports.`);
}
