import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Use a real installed checkout's Playwright, with an empty browser cache.
const source = process.env.RER_TEST_PLAYWRIGHT_ROOT ?? resolve(import.meta.dirname, '../default-seed');
const require = createRequire(join(source, 'package.json'));
const name = ['playwright-core', '@playwright/test', 'playwright'].find(name => { try { require.resolve(name + '/package.json'); return true; } catch { return false; } });
if (!name) throw Error('The test needs an installed checkout with Playwright.');
const playwright = dirname(require.resolve(name + '/package.json'));

test('doctor diagnoses missing Chromium and headless shell without provisioning them', { timeout: 30000 }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'rer-browser-doctor-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const browsers = join(root, 'empty-browsers'), home = join(root, 'home'), bin = join(root, 'empty-bin');
 await Promise.all([mkdir(browsers), mkdir(home), mkdir(bin), mkdir(join(root, 'scripts')), mkdir(join(root, 'node_modules/@playwright'), { recursive: true })]);
 await symlink(resolve(import.meta.dirname, '../bin/rer.mjs'), join(root, 'scripts/rer.mjs'));
 await symlink(playwright, join(root, 'node_modules', name), 'dir');
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node } }));
 await writeFile(join(root, 'adapter.mjs'), "export const commandAdapter = { version: 1, state: '.local/state', hooks: { secrets: { file: '.dev.vars' } } };\n");
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'example/browser-doctor', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { doctor: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Read-only diagnostics.' } } }));
 for (const entry of ['../bin/rer.mjs', '../global/rer.mjs']) {
  for (const json of [true, false]) {
   const child = spawn(process.execPath, [resolve(import.meta.dirname, entry), 'doctor', ...(json ? ['--json'] : [])], { cwd: root, env: { HOME: home, PATH: bin, PLAYWRIGHT_BROWSERS_PATH: browsers, RER_NODE_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal });
   let stdout = '', stderr = '';
   child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
   child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
   const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
   assert.equal(code, 3, stderr + stdout);
   const report = json ? JSON.parse(stdout.trim()).diagnostics : JSON.parse(stdout.slice(0, stdout.lastIndexOf('\ndoctor:')));
   assert.equal(report.ok, false);
   assert.equal(report.browser.ok, false);
   assert.equal(report.browser.fix, 'rer install');
   assert.deepEqual(report.browser.executables.map(({ name, ok }) => ({ name, ok })), [{ name: 'chromium', ok: false }, { name: 'chromium-headless-shell', ok: false }]);
   assert.ok(report.browser.executables.every(({ path }) => path.startsWith(browsers)), 'the checkout Playwright resolves the requested browser cache');
   assert.deepEqual(await readdir(browsers), [], 'doctor leaves the browser cache empty');
   assert.deepEqual(await readdir(home), [], 'doctor acquires no runtime or package manager');
  }
 }
});
