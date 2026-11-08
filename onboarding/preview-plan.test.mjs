import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { previewTarget } from './operator-installer.mjs';

// Enter through the preview start target, keeping its real planner, options
// conversion, Miniflare listener and shutdown. Only Wrangler's resolver is fake.
async function preview(t, mode) {
 const root = await mkdtemp(join(tmpdir(), 'preview-plan-'));
 let child, done;
 t.after(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await done;
  await rm(root, { recursive: true, force: true });
 });
 await mkdir(join(root, 'node_modules/wrangler'), { recursive: true });
 await mkdir(join(root, 'dist/server'), { recursive: true });
 await symlink(resolve(import.meta.dirname, '../node_modules/miniflare'), join(root, 'node_modules/miniflare'), 'junction');
 await writeFile(join(root, 'node_modules/wrangler/package.json'), JSON.stringify({ name: 'wrangler', main: 'index.cjs' }));
 await writeFile(join(root, 'node_modules/wrangler/index.cjs'), `
exports.unstable_readConfig = () => {
 ${mode === 'banners' ? `console.log('Using secrets defined in .dev.vars'); console.log('(node:123) ExperimentalWarning: VM Modules is an experimental feature and might change at any time');` : ''}
 ${mode === 'failed' ? `throw Error('Synthetic planner failure');` : ''}
 ${mode === 'empty' ? `process.exit(0);` : ''}
 return { name: 'preview-plan-fixture' };
};
exports.unstable_getMiniflareWorkerOptions = () => ({
 main: require('node:path').resolve('dist/server/index.mjs'),
 workerOptions: { compatibilityDate: '2026-09-01', modulesRules: [] }, externalWorkers: [],
});
`);
 await writeFile(join(root, '.dev.vars'), 'PREVIEW_SETTING=test-synthetic-preview-setting\n');
 await writeFile(join(root, 'dist/server/index.mjs'), `export default {fetch(request, env) {
 return Response.json({status:'ok', origin:env.AUTH_ORIGIN, settingsResolved:env.PREVIEW_SETTING==='test-synthetic-preview-setting'});
}};\n`);
 const origin = 'http://127.0.0.1:49999';
 const [command, args, { runtimePortHandshake, ...options }] = previewTarget({ origin });
 assert.equal(runtimePortHandshake, true);
 child = spawn(command, args, { ...options, cwd: root });
 let stdout = '', stderr = '';
 const announcements = [];
 child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
 child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
 child.on('message', message => { announcements.push(message); });
 done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
 return { child, done, origin, announcements, output: () => ({ stdout, stderr }), async listening() {
  return new Promise((resolve, reject) => {
   const timer = setTimeout(() => reject(Error('Preview did not announce its listener')), 20_000);
   const message = value => { if (value.type === 'rer-listening') { clearTimeout(timer); resolve(value); } };
   child.on('message', message);
   done.then(code => { clearTimeout(timer); reject(Error(`Preview exited ${code}: ${stderr}`)); }, reject);
  });
 } };
}

for (const mode of ['quiet', 'banners']) test(`preview resolves its plan and listens with ${mode} planner stdout`, { timeout: 30_000 }, async t => {
 const f = await preview(t, mode), address = await f.listening();
 assert.equal(address.requestedPort, 0);
 assert.ok(address.port > 0);
 const response = await fetch(`http://127.0.0.1:${address.port}/health`);
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { status: 'ok', origin: f.origin, settingsResolved: true });
 const { stdout, stderr } = f.output();
 assert.equal(stdout, '', 'the plan and planner diagnostics stay off runtime stdout');
 if (mode === 'banners') {
  assert.match(stderr, /Using secrets defined in \.dev\.vars/);
  assert.match(stderr, /ExperimentalWarning:/);
 }
 assert.ok(!(stdout + stderr).includes('test-synthetic-preview-setting'), 'private plan bindings stay in the pipe');
});

for (const mode of ['failed', 'empty']) test(`preview refuses ${mode} planning`, { timeout: 30_000 }, async t => {
 const f = await preview(t, mode);
 assert.notEqual(await f.done, 0);
 assert.deepEqual(f.announcements, [], 'failed planning never announces a listener');
 assert.match(f.output().stderr, /Resolving the Worker configuration failed\./);
});
