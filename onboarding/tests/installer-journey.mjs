import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportReference } from '../../scripts/export-reference.mjs';
import { createOutputRoot, finishOutputRoot } from '../ui/browser-output.mjs';

// The browser installer as an owner runs it: `node scripts/install.mjs` from a
// fresh standalone reference checkout, which stays the long-lived process that
// launches install, setup and preview. The owner approves in the page, opens the
// app and signs in from the newest outbox message.
const base = resolve(import.meta.dirname, '../..');
const { chromium } = createRequire(join(base, 'default-seed/package.json'))('@playwright/test');
const taskTemp = resolve(process.env.TMPDIR || tmpdir());
const outputRoot = await createOutputRoot(taskTemp);
const directory = await mkdtemp(join(taskTemp, 'installer-journey-'));
const root = join(directory, 'default-seed'), temporary = join(directory, '.temporary');
const env = {
  ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'PLAYWRIGHT_BROWSERS_PATH'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
  PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', RER_SERVER_JOURNEY: '1',
  RER_JOBS_DIR: join(directory, 'jobs'), RER_JOBS_LOAD_THRESHOLD: '100000', RER_JOBS_MIN_FREE_MEMORY_BYTES: '0', RER_SERVERS_LOAD_THRESHOLD: '100000', RER_SERVERS_MIN_MEMORY_BYTES: '0',
  TMPDIR: temporary, TMP: temporary, TEMP: temporary, WRANGLER_SEND_METRICS: 'false',
};
const email = 'journey-owner@example.test';
let installer, browser, output = '', passed = false;
const exited = () => installer.exitCode !== null || installer.signalCode !== null;
const portFree = port => new Promise(done => { const socket = createServer(); socket.once('error', () => done(false)); socket.listen(port, '127.0.0.1', () => socket.close(() => done(true))); });

try {
  await mkdir(temporary, { mode: 0o700 });
  await exportReference(base, root);
  installer = spawn(process.execPath, ['scripts/install.mjs', '--no-open', '--no-prefill'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [installer.stdout, installer.stderr]) stream.on('data', chunk => { output += chunk; });
  let origin;
  for (const deadline = Date.now() + 60_000; !(origin = /installer: (http:\/\/\S+)/.exec(output)?.[1]);) {
    assert.ok(!exited() && Date.now() < deadline, 'the installer did not start:\n' + output);
    await new Promise(done => setTimeout(done, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.locator('#OWNER_EMAIL').waitFor();
    // Answer each step the reference asks: its owner email and name.
    for (let step = 0; step < 10 && await page.locator('#continue').isVisible(); step++) {
      for (const input of await page.locator('#fields input:visible').all()) {
        if (await input.inputValue()) continue;
        await input.fill(await input.getAttribute('type') === 'email' ? email : 'Journey Owner');
      }
      await page.locator('#heading').click();
      await page.locator('#continue').click();
      await page.waitForTimeout(200);
    }
    await page.locator('#approve').click();
    // Install, setup (build, migrations, owner claim) and preview all run here.
    await page.waitForFunction(() => document.querySelector('#open')?.dataset.devOpen === 'ready' || !document.querySelector('#failed-note')?.hidden, null, { timeout: 15 * 60_000 });
    assert.equal(await page.locator('#open').getAttribute('data-dev-open'), 'ready', 'the browser installer finished:\n' + await page.locator('#installation').innerText());
    const app = new URL(await page.locator('#open').getAttribute('href')).origin;

    // Open the app from the installer, as the owner does, then follow the
    // newest sign-in message in the development outbox.
    await page.locator('#open').click();
    await page.waitForURL(app + '/__dev/outbox**');
    await page.locator('article a[href*="message="]').first().click();
    await page.locator('a.open').click();
    await page.waitForURL(app + '/auth/confirm**');
    await page.locator('form button[type="submit"], button[type="submit"]').first().click();
    await page.waitForURL(url => !url.pathname.startsWith('/auth/confirm'));
    const session = await (await context.request.get(app + '/auth/session')).json();
    assert.equal(session.operator?.email, email);
    assert.equal(session.operator?.role, 'owner');
    assert.deepEqual(errors, []);

    // The installer is not the caller of a separate terminal's setup: that run
    // is still refused while the installer and its app hold this checkout.
    const separate = spawn(process.execPath, ['scripts/rer.mjs', 'setup', '--owner-email', email, '--non-interactive', '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let events = ''; separate.stdout.on('data', chunk => { events += chunk; });
    const code = await new Promise(done => separate.once('close', done));
    assert.equal(code, 4, events);
    assert.ok(events.split('\n').some(line => { try { const event = JSON.parse(line); return event.event === 'error' && event.code === 'safety_refusal'; } catch { return false; } }), events);
    console.log('Installer journey: browser install, setup, open and outbox sign-in passed; a separate setup was refused');

    process.kill(-installer.pid, 'SIGTERM');
    await new Promise(done => exited() ? done() : installer.once('exit', done));
    assert.equal(await portFree(Number(new URL(app).port)), true, 'closing the installer stops the application');
    passed = true;
  } finally {
    if (!passed) await page.screenshot({ path: join(outputRoot, 'screenshots', 'installer-journey-failure.png'), fullPage: true }).catch(() => {});
    await context.close();
  }
} catch (error) {
  console.error(output.slice(-6000));
  const log = await readFile(join(root, '.seed/installer/install.log'), 'utf8').catch(() => '');
  if (log) console.error(log.slice(-6000));
  throw error;
} finally {
  await browser?.close();
  if (installer && !exited()) { try { process.kill(-installer.pid, 'SIGKILL'); } catch {} }
  await rm(directory, { recursive: true, force: true });
  if (!await finishOutputRoot(outputRoot, { passed })) console.error(`Installer journey output kept at ${outputRoot}`);
}
