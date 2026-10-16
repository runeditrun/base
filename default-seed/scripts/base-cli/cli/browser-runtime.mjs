// Browser prerequisites come from the checkout's Playwright, including its
// platform/revision and PLAYWRIGHT_BROWSERS_PATH handling. Inspection never
// launches a browser or downloads anything.
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { RerError } from './errors.mjs';
import { shared } from './shared.mjs';

export const browserRepair = 'rer install';

export function checkoutPlaywright(root, { required = true } = {}) {
 const require = createRequire(join(root, 'package.json'));
 for (const name of ['playwright-core', '@playwright/test', 'playwright']) {
  let entry;
  try { entry = require.resolve(name); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
  const playwright = require(name);
  if (!playwright.chromium) continue;
  let scope = createRequire(entry);
  if (name === '@playwright/test') scope = createRequire(scope.resolve('playwright'));
  const core = dirname(scope.resolve('playwright-core/package.json'));
  const manifest = scope(join(core, 'package.json'));
  // Playwright's bundled releases export the same registry through coreBundle;
  // older checkout pins keep it in the server module tree.
  const { registry } = manifest.exports?.['./lib/coreBundle']
   ? scope('playwright-core/lib/coreBundle').registry
   : scope(join(core, 'lib/server/registry/index.js'));
  return { name, playwright, registry, cli: join(core, 'cli.js') };
 }
 if (required) throw new RerError('browser_dependency_missing', `The checkout's Playwright is missing. Run ${browserRepair} to install its locked dependencies; verification requires playwright-core, @playwright/test or playwright.`, 3);
}

export async function browserDoctor(root) {
 let resolved;
 try { resolved = checkoutPlaywright(root); }
 catch (error) { return { ok: false, issue: error instanceof RerError ? error.message : `The checkout's Playwright could not be inspected. Run ${browserRepair}.`, fix: browserRepair, executables: [] }; }
 const executables = [];
 for (const name of ['chromium', 'chromium-headless-shell']) {
  // Releases before the separate headless shell use the Chromium executable.
  const executable = resolved.registry.findExecutable(name);
  if (!executable && name === 'chromium-headless-shell') continue;
  const path = executable?.executablePath();
  let ok = false;
  if (path) try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); ok = true; } catch {}
  executables.push({ name, ...(path ? { path } : {}), ok });
 }
 const missing = executables.filter(executable => !executable.ok).map(executable => executable.name);
 return { ok: !missing.length, package: resolved.name, executables, ...(missing.length ? { issue: `Playwright browser executables are missing: ${missing.join(', ')}. Run ${browserRepair}.`, fix: browserRepair } : {}) };
}

export async function ensureChromium(root, store, signal, { required = true } = {}) {
 // Installing a first-party adapter without browser dependencies remains valid.
 // Verification requires Playwright; installation provisions it when declared.
 const resolved = checkoutPlaywright(root, { required });
 if (!resolved) return;
 const before = await browserDoctor(root);
 if (before.ok) return;
 const { cli } = resolved;
 const { dependencyEnvironment } = await shared('dependency-environment.mjs');
 const env = dependencyEnvironment();
 if (process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
 await store.run('Installing Chromium and its headless shell from the checkout’s Playwright', 'pnpm', ['exec', 'node', cli, 'install', 'chromium'], { cwd: root, signal, env, display: `pnpm exec node ${relative(root, cli)} install chromium` });
 const after = await browserDoctor(root);
 if (!after.ok) throw new RerError('browser_install_incomplete', after.issue, 3);
}
