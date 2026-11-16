import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm, readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { browserDoctor, browsersPresent, ensureChromium } from './browser-runtime.mjs';

// Synthetic checkout registry: paths belong to its pin/cache, and running either
// Playwright's CLI or a browser is an error. No installed Playwright is needed.
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'rer-synthetic-browser-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const core = join(root, 'node_modules/playwright-core'), browsers = join(root, 'browsers'), home = join(root, 'home'), bin = join(root, 'empty-bin');
 await Promise.all([mkdir(join(core, 'lib/server/registry'), { recursive: true }), mkdir(join(root, 'scripts')), mkdir(browsers), mkdir(home), mkdir(bin)]);
 await symlink(execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
 await writeFile(join(root, 'scripts/rer.mjs'), `import ${JSON.stringify(resolve(import.meta.dirname, '../bin/rer.mjs'))};\n`);
 await writeFile(join(root, 'package.json'), JSON.stringify({ engines: { node: process.versions.node }, packageManager: 'pnpm@10.12.4' }));
 const declare = async headless => writeFile(join(root, 'adapter.mjs'), `export const commandAdapter = { version: 1, state: '.local/state', hooks: { secrets: { file: '.dev.vars' } }, ${headless === undefined ? '' : `browser: { headless: ${headless} },`} };\n`);
 await declare();
 await writeFile(join(root, 'OPERATIONS.json'), JSON.stringify({ version: 2, project: 'synthetic-browser-1', runtime: { requirements: [] }, requiredEnvironment: [], seedContract: { version: 1, profile: 'first-party', adapter: 'adapter.mjs' }, commands: { doctor: { argv: ['node', 'adapter.mjs'], inputs: ['adapter.mjs'], effects: 'Read-only diagnostics.' } } }));
 await writeFile(join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', main: 'index.js' }));
 await writeFile(join(core, 'index.js'), "exports.chromium = { launch() { throw Error('Inspection must not launch a browser'); } };\n");
 await writeFile(join(core, 'cli.js'), "throw Error('Inspection must not download a browser');\n");
 await writeFile(join(core, 'lib/server/registry/index.js'), `const { join } = require('node:path');
const { existsSync } = require('node:fs');
exports.registry = { findExecutable(name) {
 if (name === 'chromium-headless-shell' && existsSync(join(__dirname, 'legacy'))) return;
 return { executablePath() { return join(${JSON.stringify(browsers)}, name); } };
} };\n`);
 const present = async name => { const path = join(browsers, name); await writeFile(path, '#!/bin/sh\nexit 97\n'); await chmod(path, 0o755); };
 const run = async (entry, verb, json = true) => {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, entry), verb, ...(json ? ['--json'] : [])], { cwd: root, env: { HOME: home, PATH: bin, PLAYWRIGHT_BROWSERS_PATH: browsers, RER_NODE_AUTO: '0' }, stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(code !== null, stderr + stdout);
  // These minimal fixtures intentionally lack unrelated local prerequisites.
  if (verb === 'describe') assert.equal(code, 0, stderr + stdout);
  return json ? JSON.parse(stdout.trim()) : stdout;
 };
 return { root, core, browsers, home, present, declare, run };
}

test('browser advice and first-use provisioning follow the declared use without inspection effects', { timeout: 30000 }, async t => {
 const f = await fixture(t);
 const command = target => `pnpm exec node node_modules/playwright-core/cli.js install ${target}`;
 const calls = [];
 const store = { async run(label, program, args, options) {
  calls.push({ label, program, args, options });
  // Simulate the pinned CLI's install, never execute it or acquire a browser.
  await f.present('chromium-headless-shell');
  if (args.at(-1) === 'chromium') await f.present('chromium');
 } };
 for (const state of ['neither', 'shell-only', 'both', 'headed-shell-only']) {
  if (state === 'shell-only') await f.present('chromium-headless-shell');
  if (state === 'both') await f.present('chromium');
  if (state === 'headed-shell-only') { await rm(join(f.browsers, 'chromium')); await f.declare(false); }
  const missing = ['neither', 'headed-shell-only'].includes(state);
  for (const entry of ['../bin/rer.mjs', '../global/rer.mjs']) {
   const report = (await f.run(entry, 'doctor')).diagnostics.browser;
   const description = (await f.run(entry, 'describe')).browser;
   assert.deepEqual(description, report, 'describe and doctor inspect the same declared requirement');
   assert.equal(report.ok, true, 'a deferred browser download is not a broken dependency');
   assert.ok(report.executables.every(({ path }) => path.startsWith(f.browsers)), 'use the checkout registry paths');
   if (missing) {
    const target = state === 'neither' ? 'chromium-headless-shell' : 'chromium';
    assert.equal(report.command, command(target));
    assert.ok(report.note.includes(target) && report.note.includes(command(target)));
    assert.match(report.note, state === 'neither' ? /headless verification/ : /headed browser use/);
    assert.match(report.note, /rer install.*not browsers/);
    assert.equal(report.note.split(command(target)).length - 1, 1, 'one browser-only command');
    const human = await f.run(entry, 'doctor', false);
    assert.ok(human.includes(report.note), 'human diagnostics retain the actionable guidance');
   } else {
    assert.equal(report.note, undefined, 'a present headless shell needs no full Chromium warning');
    assert.equal(report.command, undefined);
    assert.deepEqual(report.executables.map(({ name, ok }) => ({ name, ok })), [{ name: 'chromium-headless-shell', ok: true }]);
    assert.doesNotMatch(await f.run(entry, 'doctor', false), /not downloaded|browser-only install/i);
   }
  }
  assert.deepEqual(await readdir(f.home), [], 'inspection acquires no runtime or package manager');
  assert.deepEqual((await readdir(f.browsers)).sort(), state === 'neither' ? [] : state === 'both' ? ['chromium', 'chromium-headless-shell'] : ['chromium-headless-shell'], 'inspection leaves the cache unchanged');
 }
 // The same public provisioning door installs precisely what doctor advised.
 assert.equal(await browsersPresent(f.root), true, 'default headless readiness accepts the shell alone');
 await ensureChromium(f.root, store);
 assert.equal(calls.length, 0, 'a working shell triggers no download');
 await rm(join(f.browsers, 'chromium-headless-shell'));
 await ensureChromium(f.root, store);
 assert.equal(calls.length, 1);
 assert.equal(calls[0].program, 'pnpm');
 assert.deepEqual(calls[0].args, ['exec', 'node', join(f.core, 'cli.js'), 'install', 'chromium-headless-shell']);
 assert.equal(calls[0].options.display, command('chromium-headless-shell'));
 assert.equal(calls[0].options.cwd, f.root);
 assert.equal(await browsersPresent(f.root, { headless: false }), false);
 await ensureChromium(f.root, store, undefined, { headless: false });
 assert.equal(calls.length, 2);
 assert.equal(calls[1].args.at(-1), 'chromium');
 assert.equal(calls[1].options.display, command('chromium'));
 assert.equal(await browsersPresent(f.root, { headless: false }), true);
 // Older pins without a separate shell keep installing Chromium.
 await writeFile(join(f.core, 'lib/server/registry/legacy'), 'synthetic legacy pin');
 await rm(join(f.browsers, 'chromium'));
 const legacy = await browserDoctor(f.root);
 assert.deepEqual(legacy.executables.map(({ name }) => name), ['chromium']);
 assert.equal(legacy.command, command('chromium'));
 await ensureChromium(f.root, store);
 assert.equal(calls.length, 3);
 assert.equal(calls[2].args.at(-1), 'chromium');
 // A download returning success without its executable must still refuse.
 await rm(join(f.browsers, 'chromium'));
 await assert.rejects(ensureChromium(f.root, { run: async () => {} }), { code: 'browser_install_incomplete' });
});
