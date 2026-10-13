// rer dev --stop through the rer command, on a fresh default-seed export: sent
// with the launch, while it prepares, and the moment `rer dev` returns. Each
// stop ends the launch and every process it started, and says what it stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportReference } from '../../scripts/export-reference.mjs';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { freePort, processesIn, run, sweep } from './harness.mjs';

const base = resolve(import.meta.dirname, '../..');

test('rer dev --stop at any moment of a launch stops it and everything it started', { timeout: 15 * 60_000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'rer-stop-')), root = join(directory, 'seed');
 const env = await isolatedQueue(t, { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false', RER_SERVERS_DIR: join(directory, 'servers'), ...Object.fromEntries(['TMPDIR', 'COREPACK_HOME', 'npm_config_store_dir'].filter(name => process.env[name]).map(name => [name, process.env[name]])) });
 const rer = (args, options) => run(process.execPath, [join(base, 'global/rer.mjs'), ...args], { cwd: root, env, ...options });
 t.after(async () => {
  try {
   await rer(['dev', '--stop']);
   assert.deepEqual((await sweep(root)).map(item => item.command), [], 'nothing of the checkout is left running');
  } finally { await rm(directory, { recursive: true, force: true }); }
 });
 await exportReference(base, root);
 const port = String(await freePort()), url = `http://127.0.0.1:${port}`;
 const nothingLeft = async moment => assert.deepEqual((await processesIn(root)).map(item => item.command), [], `nothing of the launch runs after a stop ${moment}`);

 // Sent with the launch, before its worker can have claimed the checkout.
 let launching = rer(['dev', '--port', port]);
 let stopped = await rer(['dev', '--stop']), launched = await launching;
 assert.equal(stopped.code, 0, stopped.stderr);
 assert.notEqual(launched.code, 0, 'a launch stopped as it began does not report ready');
 assert.doesNotMatch(launched.stdout, /^RER_READY /m);
 await nothingLeft('sent with the launch');

 // While it prepares: at its first progress line, as it installs.
 let preparing;
 const started = new Promise(resolvePreparing => { preparing = resolvePreparing; });
 launching = rer(['dev', '--port', port], { onStderr: preparing });
 await started;
 stopped = await rer(['dev', '--stop']); launched = await launching;
 assert.equal(stopped.code, 0, stopped.stderr);
 assert.match(stopped.stdout, /\(PID \d+\)/, 'rer dev --stop names the launch it stopped');
 assert.notEqual(launched.code, 0, 'a launch stopped while preparing does not report ready');
 assert.doesNotMatch(launched.stdout, /^RER_READY /m);
 await nothingLeft('while the launch prepares');

 // The moment rer dev returns with the server ready.
 launched = await rer(['dev', '--port', port]);
 assert.equal(launched.code, 0, launched.stderr + launched.stdout);
 assert.match(launched.stdout, new RegExp(`^RER_READY ${url}$`, 'm'));
 const serving = await processesIn(root);
 assert.ok(serving.length, 'the server runs in the checkout');
 stopped = await rer(['dev', '--stop']);
 assert.equal(stopped.code, 0, stopped.stderr);
 assert.ok(serving.some(item => stopped.stdout.includes(`(PID ${item.pid})`)), `rer dev --stop names the server it stopped: ${stopped.stdout}`);
 await nothingLeft('the moment rer dev returns');
 await assert.rejects(fetch(url + '/health'), 'rer dev --stop frees the port');
});
