import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startInstaller } from './server.mjs';
import { writeTestManifest } from './test-manifest-support.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(check) {
  const deadline = Date.now() + 10000;
  do { if (await check()) return; await delay(25); } while (Date.now() < deadline);
  assert.fail('Installer process smoke did not settle');
}
async function building(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-process-smoke-'));
  await writeTestManifest(root);
  let pids = [];
  const server = await startInstaller(root, { noPrefill: true, seed: {
    product: 'Build smoke', setup: { manifestFile: 'rer-setup.json' },
    install: async (_root, _input, store) => {
      await store.step('Building');
      await store.run('Build', process.execPath, [fileURLToPath(new URL('./fixtures/build-process.mjs', import.meta.url)), join(root, 'pids.json')]);
    },
  } });
  t.after(async () => {
    try { await server.close(); }
    finally {
      for (const pid of [...pids].reverse()) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await until(() => pids.every(pid => !alive(pid)));
      await rm(root, { recursive: true, force: true });
    }
  });
  const page = await fetch(server.origin), html = await page.text();
  const headers = { Origin: server.origin, Cookie: page.headers.get('set-cookie').split(';')[0],
    'X-Installer-Token': html.match(/name="installer-token" content="([a-f0-9]+)"/)[1], 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/api/start', { method: 'POST', headers, body: '{}' })).status, 202);
  await until(async () => {
    try { pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')); return pids.length === 2; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  assert.ok(pids.every(alive));
  return { root, server, pids, headers };
}

test('cancelling the installer mid-build leaves no child running', { timeout: 30000 }, async t => {
  const { server, pids, headers } = await building(t);
  assert.equal((await fetch(server.origin + '/api/stop', { method: 'POST', headers })).status, 202);
  await until(() => server.state.phase === 'failed');
  await until(() => pids.every(pid => !alive(pid)));
  assert.ok(pids.every(pid => !alive(pid)));
});

test('a process the installer did not start survives cleanup', { timeout: 30000 }, async t => {
  const { root, server, pids } = await building(t);
  const unrelated = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = once(unrelated, 'close');
  t.after(async () => { unrelated.kill('SIGTERM'); await closed; });
  await once(unrelated.stdout, 'data');
  await server.close();
  assert.ok(pids.every(pid => !alive(pid)));
  assert.ok(alive(unrelated.pid));
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});

test('SIGTERM ends the installer promptly while a browser holds connections open', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'installer-sigterm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeTestManifest(root);
  const launcher = new URL('./launcher.mjs', import.meta.url).href;
  const installer = spawn(process.execPath, ['--input-type=module', '-e',
    `const {launch}=await import(${JSON.stringify(launcher)});await launch(process.argv[1],{product:'Signal smoke',setup:{manifestFile:'rer-setup.json'},install:async()=>{}});`,
    root, '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(installer, 'exit');
  t.after(() => { if (installer.exitCode === null && installer.signalCode === null) installer.kill('SIGKILL'); });
  let output = '';
  installer.stdout.on('data', chunk => { output += chunk; });
  await until(() => /installer: (http:\/\/127\.0\.0\.1:\d+)/.test(output));
  const origin = new URL(output.match(/installer: (http:\/\/127\.0\.0\.1:\d+)/)[1]);
  // One idle keep-alive connection after a full response, one mid-request.
  const idle = createConnection(Number(origin.port), '127.0.0.1'), active = createConnection(Number(origin.port), '127.0.0.1');
  for (const socket of [idle, active]) socket.on('error', () => {});
  await Promise.all([once(idle, 'connect'), once(active, 'connect')]);
  idle.write(`GET /rer-setup.json HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: keep-alive\r\n\r\n`);
  await once(idle, 'data');
  active.write(`GET / HTTP/1.1\r\nHost: ${origin.host}\r\n`);
  await delay(100);
  const started = Date.now();
  installer.kill('SIGTERM');
  const ended = await Promise.race([exited, delay(10000).then(() => null)]);
  assert.ok(ended, 'the installer is still running 10 s after SIGTERM');
  assert.ok(Date.now() - started < 10000);
  for (const socket of [idle, active]) socket.destroy();
});
