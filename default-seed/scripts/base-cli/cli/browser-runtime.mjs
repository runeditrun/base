// Browser prerequisites come from the checkout's Playwright, including its
// platform/revision and PLAYWRIGHT_BROWSERS_PATH handling. Inspection never
// launches a browser or downloads anything. The browser itself downloads on
// the first command that needs it (rer verify, or rer run of a Playwright
// script), never during rer install: a deploy-only owner never fetches it.
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { RerError } from './errors.mjs';
import { shared } from './shared.mjs';

export const browserRepair = '~/.local/bin/rer install';
export const browserDownload = '~/.local/bin/rer verify downloads the required browser on first use; ~/.local/bin/rer install installs dependencies, not browsers';

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

// Verification uses headless Chromium. A checkout that also needs headed
// Chromium declares commandAdapter.browser = { headless: false }.
export async function browserDoctor(root, { headless = true } = {}) {
 let resolved;
 try { resolved = checkoutPlaywright(root); }
 catch (error) { return { ok: false, issue: error instanceof RerError ? error.message : `The checkout's Playwright could not be inspected. Run ${browserRepair}.`, fix: browserRepair, executables: [] }; }
 const shell = resolved.registry.findExecutable('chromium-headless-shell');
 const names = headless && shell ? ['chromium-headless-shell'] : ['chromium', ...(shell ? ['chromium-headless-shell'] : [])];
 const executables = [];
 for (const name of names) {
  // Releases before the separate headless shell use the Chromium executable.
  const executable = name === 'chromium-headless-shell' ? shell : resolved.registry.findExecutable(name);
  const path = executable?.executablePath();
  let ok = false;
  if (path) try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); ok = true; } catch {}
  const reason = name === 'chromium-headless-shell' ? 'headless verification' : headless ? 'headless verification with this Playwright pin (no separate headless shell)' : 'declared headed browser use';
  executables.push({ name, ...(path ? { path } : {}), ok, reason });
 }
 // Not yet downloaded is the normal state until a command needs the browser.
 const missing = executables.filter(executable => !executable.ok);
 const target = headless && shell ? 'chromium-headless-shell' : 'chromium';
 const command = browserInstallCommand(root, resolved.cli, target);
 return { ok: true, package: resolved.name, headless, executables, ...(missing.length ? { command, note: `Playwright browser not downloaded yet: ${missing.map(({ name, reason }) => `${name} (needed for ${reason})`).join(', ')}. Browser-only install: ${command}; ${browserDownload}.` } : {}) };
}

// Quote project-relative paths for a command copied into the checkout's shell.
function browserInstallCommand(root, cli, target) {
 const path = relative(root, cli).split('\\').join('/');
 const quoted = /^[a-zA-Z0-9_./@-]+$/.test(path) ? path : process.platform === 'win32' ? `"${path}"` : "'" + path.replaceAll("'", "'\\''") + "'";
 return `pnpm exec node ${quoted} install ${target}`;
}

export async function ensureChromium(root, store, signal, { required = true, ...use } = {}) {
 // A first-party adapter without browser dependencies remains valid.
 // Verification requires Playwright; rer run provisions it when declared.
 const resolved = checkoutPlaywright(root, { required });
 if (!resolved) return;
 const browser = await browserDoctor(root, use);
 if (!browser.note) return;
 const target = browser.headless && resolved.registry.findExecutable('chromium-headless-shell') ? 'chromium-headless-shell' : 'chromium';
 const { dependencyEnvironment } = await shared('dependency-environment.mjs');
 const env = dependencyEnvironment();
 if (process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
 await store.run(`Installing ${target} from the checkout’s Playwright`, 'pnpm', ['exec', 'node', resolved.cli, 'install', target], { cwd: root, signal, env, display: browser.command });
 const after = await browserDoctor(root, use);
 const absent = after.executables.filter(executable => !executable.ok).map(executable => executable.name);
 if (absent.length) throw new RerError('browser_install_incomplete', `The checkout's Playwright did not install the required browser (missing: ${absent.join(', ')}). Run ${browser.command} again; it retries the download.`, 3);
}

// Whether the executables needed by this checkout's declared use are on disk.
export async function browsersPresent(root, use) {
 const browser = await browserDoctor(root, use).catch(() => undefined);
 return Boolean(browser?.ok && !browser.note);
}
