// Shared by Linux bootstrap and the pinned, read-only browser qualification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dependencyHelper = fileURLToPath(new URL('../../export/install-chromium-deps.py', import.meta.url));
const permissionError = /EACCES|EPERM|permission denied|operation not permitted/i;

function command(program, args, cwd, env) {
  const result = spawnSync(program, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (exit=${result.status}, signal=${result.signal})`);
}

async function ownedDirectory(path) {
  // Create as the caller before sudo. Never repair a permission problem by
  // creating/chowning caller HOME or browser directories as root.
  await mkdir(path, { recursive: true });
  const info = await stat(path);
  if (info.uid !== process.getuid()) throw new Error(`EACCES: cache ${path} belongs to uid ${info.uid}, caller uid ${process.getuid()}`);
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

export async function probeBrowser(packageRoot) {
  const require = createRequire(resolve(packageRoot, 'package.json'));
  const version = require('@playwright/test/package.json').version;
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({
    headless: true, args: ['--use-mock-keychain', '--password-store=basic'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Bootstrap browser probe</title>');
    assert.equal(await page.title(), 'Bootstrap browser probe');
    console.log(`Chromium ${browser.version()} launched successfully (Playwright ${version})`);
    return { playwright: version, chromium: browser.version() };
  } finally {
    await browser.close();
  }
}

export async function setupBrowser({ packageRoot, baseline = false, aptArchives, env = process.env, result = {} }) {
  packageRoot = resolve(packageRoot);
  aptArchives = resolve(aptArchives ?? resolve(env.RUNNER_TEMP ?? resolve(homedir(), '.cache'), 'rer-apt/archives'));
  const browsers = resolve(env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache'), 'ms-playwright'));
  const started = performance.now();
  Object.assign(result, { baseline, browsers, aptArchives, steps: [], aptUsed: false });
  async function measure(phase, run) {
    const step = { phase };
    const start = performance.now();
    result.steps.push(step);
    try { const value = await run(); step.passed = true; return value; }
    catch (error) { step.passed = false; step.error = error.message; throw error; }
    finally { step.seconds = (performance.now() - start) / 1000; }
  }
  const dependencies = async () => {
    result.aptUsed = true;
    await measure('system-dependencies', () => {
      const args = ['env', `PATH=${env.PATH}`, `APT_ARCHIVES=${aptArchives}`, 'python3', dependencyHelper];
      if (process.getuid() === 0) command(args.shift(), args, packageRoot, env);
      else command('sudo', ['-n', ...args], packageRoot, env);
    });
  };
  try {
    await ownedDirectory(browsers);
    await ownedDirectory(aptArchives);
    // The caller and probe share the same explicitly selected browser cache.
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH ?? browsers, browsers, 'Use an absolute PLAYWRIGHT_BROWSERS_PATH');
    if (baseline) await dependencies();
    await measure('browser-install', () => command('pnpm', ['exec', 'playwright', 'install', 'chromium'], packageRoot, env));
    try {
      result.browser = await measure('launch', () => probeBrowser(packageRoot));
    } catch (error) {
      if (baseline || permissionError.test(String(error.stack ?? error))) throw error;
      console.error(`Chromium launch failed; installing bounded system dependencies: ${error.message}`);
      await dependencies();
      result.browser = await measure('launch-after-system-dependencies', () => probeBrowser(packageRoot));
    }
    result.passed = true;
    return result;
  } finally {
    result.seconds = (performance.now() - started) / 1000;
    console.log(`BROWSER_SETUP ${JSON.stringify(result)}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [packageRoot, mode, ...extra] = process.argv.slice(2);
  assert.ok(packageRoot && !extra.length && (mode === undefined || mode === '--setup'), 'Usage: node browser-probe.mjs PACKAGE_ROOT [--setup]');
  if (mode === '--setup') await setupBrowser({ packageRoot });
  else await probeBrowser(packageRoot);
}
