// Real launcher and dispatcher lifetimes with only the package registry at a
// fixture edge. Each checkout starts without node_modules, forcing the global
// launcher's install-then-handoff to the newly installed package launcher.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedQueue } from '../../cli/fixtures/queue.mjs';
import { launchPath, liveWorker } from '../launch/state.mjs';
import { liveServers } from '../registry.mjs';
import { freePort, processesIn } from './harness.mjs';

const launcher = resolve(import.meta.dirname, '../rer.mjs');
const running = child => child.exitCode === null && child.signalCode === null;
async function until(condition, message, timeout = 30_000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) { if (await condition()) return; await delay(100); }
 assert.fail(typeof message === 'function' ? message() : message);
}

async function devSeed(root) {
 await writeFile(join(root, 'app.mjs'), `import { createServer } from 'node:http';
createServer((request, response) => response.end(JSON.stringify({ status: 'ok' }))).listen(Number(process.argv[2]), '127.0.0.1');
`);
 await writeFile(join(root, 'rer-setup.json'), JSON.stringify({ schema: 1, title: 'Launch lifetime', groups: [], steps: [{ type: 'extension', id: 'native-owner' }], fields: [{ name: 'OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true }] }));
 await writeFile(join(root, 'adapter.mjs'), `import { localInstaller } from '@runeditrun/rer/local-installer';
import { commandAdapter as declare } from '@runeditrun/rer/adapter';
const lifecycle = localInstaller({ secrets: { file: '.dev.vars', format: 'dotenv', originKey: 'AUTH_ORIGIN', values: ({ origin }) => ({ AUTH_ORIGIN: origin }) },
 start: context => ['node', ['app.mjs', String(context.runtimePort ?? new URL(context.origin).port)]], signIn: async () => {} });
export const commandAdapter = declare(lifecycle, { setup: { manifestFile: 'rer-setup.json' }, input: { names: { email: 'OWNER_EMAIL' } }, settings: ['.dev.vars'] });
`);
}

export async function devModes(t, seed, environment) {
 for (const mode of ['--foreground', '--detach', undefined]) await t.test(mode ?? 'piped default', async t => {
  const name = `dev-${mode?.slice(2) ?? 'default'}`;
  const fixture = await seed(name), root = await realpath(fixture.root);
  await devSeed(root);
  await assert.rejects(readFile(join(root, 'node_modules/@runeditrun/rer/package.json')), { code: 'ENOENT' });
  const env = await isolatedQueue(t, { ...environment, CI: 'true', RER_SERVERS_DIR: join(root, '..', `${name}-servers`) });
  const directory = launchPath(await realpath(root), env), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [launcher, 'dev', ...(mode ? [mode] : []), '--port', String(port), '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', closed = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('close', code => { closed = true; resolveDone(code); }); });
  // Only PIDs from this invocation and its private registry are ours to stop.
  t.after(async () => {
   if (running(child)) child.kill('SIGTERM');
   for (const record of await liveServers(env)) if (record.checkout === await realpath(root)) {
    try { process.kill(record.owner.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
   }
   const worker = await liveWorker(directory);
   if (worker) try { process.kill(worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
   await until(async () => !(await processesIn(root)).length, 'owned fixture processes stopped');
   await done;
  });
  await until(() => stdout.includes('"event":"ready"') || closed, () => `launch reached readiness: ${stdout}${stderr}`, 120_000);
  assert.ok(stdout.includes('"event":"ready"'), stdout + stderr);
  assert.ok(!(stdout + stderr).includes('rer-dev='), 'output without a terminal never carries the sign-in link');
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.ok(JSON.parse(await readFile(join(root, 'node_modules/@runeditrun/rer/package.json'), 'utf8')).version, 'dev installed the checkout pin before starting');
  if (mode === '--foreground') {
   // Give a mistaken detached follow time to return, rather than sampling
   // the brief interval between its ready event and process exit.
   await delay(1000);
   assert.ok(running(child), 'foreground rer keeps owning the server under non-TTY stdout');
   assert.equal((await liveServers(env))[0]?.owner.pid, child.pid, 'the invoked PID owns the foreground server');
   assert.equal(await liveWorker(directory), undefined, 'foreground created no detached launch worker');
   assert.ok(!(await readdir(directory)).some(name => name === 'server.json' || name === 'worker.json' || name.startsWith('events-')), 'foreground created no detached launch state');
   child.kill('SIGTERM');
   await done;
  } else {
   await until(() => closed, 'detached invocation returned after readiness');
   assert.equal(await done, 0, stderr);
   assert.equal((await fetch(url + '/health')).status, 200, 'detached server outlives its caller');
   const [record] = await liveServers(env);
   assert.ok(record?.owner.pid && record.owner.pid !== child.pid, 'a separate PID owns detached serving');
   process.kill(record.owner.pid, 'SIGTERM');
  }
  await until(async () => !(await processesIn(root)).length && !(await liveServers(env)).length && !await liveWorker(directory), 'stopping the owned PID releases serving and launch custody');
  await assert.rejects(fetch(url + '/health'), 'the owned server stopped');
 });
}
